import { parse, type Expr, type Stmt } from './parser.ts';
import { ScriptSyntaxError, type ScriptError } from './lexer.ts';
import { Interpreter, charge, declaredNames, numberSites, type Budget, type Host } from './interpreter.ts';
import { DateValue, HostObject, NativeFunction, ScriptRuntimeError, fromData, isPlain, num, own, plain, text, toData, truthy, type Value } from './values.ts';
import { BUILTINS, makeInstance, type Instance } from './builtins.ts';
import { COLOR_NAMES, interpolateColors, rgb } from './colors.ts';
import { PLOT_FIELDS, type OptionDecl, type PlotKind, type PlotOut, type ScriptResult, type Warning } from '../protocol.ts';
import { filterKey, type BarInputs, type SourceFilter, type SourceInputs } from '../inputs.ts';
import type { OptionValue } from '../records.ts';

/**
 * A script from text to plots. `analyze` reads it without running it (what it declares, which sets of markets it reads), so the page can
 * gather the inputs before a run; `runScript` runs it over every candle, oldest first, one pass of the interpreter per candle.
 *
 * The language (version 1): JavaScript's expressions and statements as `parser.ts` reads them, with these names:
 * - inputs of the candle: `time` (its start, seconds), `vbuy`, `vsell` (USD bought and sold at market over the markets read), `lbuy`, `lsell`
 *   (USD of shorts and longs liquidated), `cbuy`, `csell` (trade counts: not recorded, always NaN), `bar` (all of those, and `timestamp`),
 *   `$price` (the chart's candle: `open`, `high`, `low`, `close`; setting `$price.color` colours it), `renderer.length` (candles so far);
 * - `options.name` and `name = option(default = ..., type = ..., label = ..., min, max, step)`: the script's settings;
 * - `source(expr, type = spot|perp, exchange = NAME, quote = USDT)`: `expr` read over those markets only;
 * - a name assigned at the top without `var`/`let`/`const` keeps its value from candle to candle, and `name[1]` is its value one candle back;
 * - the functions of `builtins.ts` (`sma`, `ema`, `cum`, ...), each call keeping its own state, and the plots (`line`, `histogram`, ...).
 * A candle that was not recorded reads NaN, and a function given NaN answers NaN and keeps its state, so a line starts where the data does.
 */

export const API_VERSION = 1;

/** The plot functions and the kind each draws. */
const PLOTS: Readonly<Record<string, PlotKind>> = {
  plotline: 'line', line: 'line', plotarea: 'area', area: 'area', plothistogram: 'histogram', histogram: 'histogram',
  plotbaseline: 'baseline', baseline: 'baseline', plotcandlestick: 'candlestick', candlestick: 'candlestick', plotbar: 'bar', bar_plot: 'bar',
  plotcloudarea: 'cloudarea', cloudarea: 'cloudarea', plotbrokenarea: 'brokenarea', brokenarea: 'brokenarea',
};

/** The most plots a script may make, and the most named sets of markets it may read. */
export const MAX_PLOTS = 64, MAX_SOURCES = 24;
/** The steps a run may take per candle (on average), and its time. */
export const STEPS_PER_CANDLE = 40_000, RUN_MS = 2_500;

export interface Analysis {
  program: Stmt[];
  /** The `source(...)` calls, for their filters (`sourcesWith`). */
  sourceCalls: Extract<Expr, { k: 'call' }>[];
  /** The candle inputs it reads (`vbuy`, `lsell`, ...). */
  inputs: Set<string>;
  /** Names kept from candle to candle. */
  persistent: Set<string>;
  /** The sets of markets the script reads (`source(...)`), by key, with their filters ('' is always there). */
  sources: Map<string, SourceFilter>;
  /** Options it declares (`option(...)`), in the order they appear. */
  declared: OptionDecl[];
  /** `options.name` it reads. */
  read: string[];
  warnings: Warning[];
}

const KNOWN_INPUTS = new Set(['time', 'vbuy', 'vsell', 'cbuy', 'csell', 'lbuy', 'lsell', 'bar', '$price', 'options', 'renderer', 'fns', 'Math', 'Number', 'String', 'Boolean', 'Date', 'Array', 'Object', 'JSON', 'Infinity', 'NaN', 'undefined', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'rgb', 'rgba', 'option', 'source', 'nz', 'na']);

/** An exchange's name as scripts write it, as the page's exchange (and the kind its name implies, where it does). */
export function exchangeOf(name: string): { venue: string; kind?: 'spot' | 'perp' } {
  const n = name.trim().toUpperCase();
  const table: Record<string, { venue: string; kind?: 'spot' | 'perp' }> = {
    BINANCE: { venue: 'binance', kind: 'spot' }, BINANCE_FUTURES: { venue: 'binance', kind: 'perp' }, BINANCE_US: { venue: 'binanceus', kind: 'spot' },
    OKEX: { venue: 'okx' }, OKX: { venue: 'okx' }, HUOBI: { venue: 'htx' }, HTX: { venue: 'htx' }, GATEIO: { venue: 'gateio' }, GATE: { venue: 'gateio' },
    CRYPTOCOM: { venue: 'cryptocom' }, KRAKEN: { venue: 'kraken' }, KRAKEN_FUTURES: { venue: 'kraken', kind: 'perp' }, BITFINEX: { venue: 'bitfinex' },
    BITSTAMP: { venue: 'bitstamp', kind: 'spot' }, COINBASE: { venue: 'coinbase', kind: 'spot' }, BITMEX: { venue: 'bitmex', kind: 'perp' }, DERIBIT: { venue: 'deribit', kind: 'perp' },
    DYDX: { venue: 'dydx', kind: 'perp' }, HYPERLIQUID: { venue: 'hyperliquid', kind: 'perp' }, BYBIT: { venue: 'bybit' }, BITGET: { venue: 'bitget' }, KUCOIN: { venue: 'kucoin' },
    MEXC: { venue: 'mexc' }, PHEMEX: { venue: 'phemex' }, POLONIEX: { venue: 'poloniex', kind: 'spot' }, WHITEBIT: { venue: 'whitebit' }, ASTER: { venue: 'aster', kind: 'perp' },
  };
  return own(table, n) ?? { venue: n.toLowerCase().replace(/_futures$/, '') };
}

/** A literal value of a call's named argument read without running the script (a number, a text, a plain word, true/false, `rgb(...)`), or undefined. */
function literal(e: Expr): OptionValue | undefined {
  if (e.k === 'num' || e.k === 'str') return e.v;
  if (e.k === 'id') return e.name === 'true' ? true : e.name === 'false' ? false : e.name === 'null' ? null : e.name;
  if (e.k === 'un' && e.op === '-' && e.arg.k === 'num') return -e.arg.v;
  if (e.k === 'call' && e.callee.k === 'id' && (e.callee.name === 'rgb' || e.callee.name === 'rgba') && e.args.every(a => a.k === 'num' || (a.k === 'un' && a.arg.k === 'num'))) return rgb(e.args.map(a => Number(literal(a))));
  if (e.k === 'arr') { const items = e.items.map(literal); return items.every(x => x !== undefined) ? items as OptionValue[] : undefined; }
  return undefined;
}

/**
 * A plot's named argument as it can be read before the script runs: a literal, an option (`options.up`, or a declared option's name), an object
 * of those (`scaleMargins={top: 0.1}`), or a plain word that names nothing in the script (`title=PERP`). Undefined for anything the script
 * works out (it is read when the plot first runs).
 */
function staticValue(e: Expr, opt: Readonly<Record<string, Value>>, scriptNames: ReadonlySet<string>): OptionValue | undefined {
  if (e.k === 'member' && e.obj.k === 'id' && e.obj.name === 'options') return toData(opt[e.name]);
  if (e.k === 'id') {
    if (Object.prototype.hasOwnProperty.call(opt, e.name)) return toData(opt[e.name]);
    if (scriptNames.has(e.name) || scriptNames.has(e.name.toLowerCase())) return undefined;
  }
  if (e.k === 'obj') {
    const o: Record<string, OptionValue> = {};
    for (const p of e.props) { const v = staticValue(p.value, opt, scriptNames); if (v === undefined) return undefined; o[p.key] = v; }
    return o;
  }
  return literal(e);
}

/** The venue a filter names when its value cannot be read: it matches no market, so an unread filter reads 0 rather than every market. */
export const UNREAD_VENUE = '?';

/**
 * A `source(...)` call's filter from its named arguments (`type`, `exchange`, `quote`; more than one value as `exchange=A+B`). A value is a
 * literal or a plain word, an option (`options.venue`, or a declared option's name: read from `opt`), or the text as written (`A+B`). A value
 * that is none of those cannot be known before the script runs: the filter then matches no market (`UNREAD_VENUE`).
 */
export function sourceFilter(named: readonly { name: string; value: Expr; raw?: string }[], opt: Readonly<Record<string, Value>> = {}): SourceFilter {
  const kinds: ('spot' | 'perp')[] = [], venues: string[] = [], quotes: string[] = [];
  for (const n of named) {
    if (n.name !== 'type' && n.name !== 'exchange' && n.name !== 'quote') continue;
    let v: unknown;
    if (n.value.k === 'member' && n.value.obj.k === 'id' && n.value.obj.name === 'options') v = opt[n.value.name];
    else if (n.value.k === 'id' && Object.prototype.hasOwnProperty.call(opt, n.value.name)) v = opt[n.value.name];
    else { v = literal(n.value); if (typeof v !== 'string' && n.raw && /^[\w+|, -]+$/.test(n.raw)) v = n.raw; }
    if (typeof v !== 'string' || !v.trim()) { venues.push(UNREAD_VENUE); continue; }
    const words = v.split(/[+,|\s]+/).filter(Boolean);
    if (n.name === 'type') for (const w of words) { const k = w.toLowerCase(); if (k === 'spot') kinds.push('spot'); else if (k === 'perp' || k === 'perpetual' || k === 'futures' || k === 'linear' || k === 'inverse') kinds.push('perp'); }
    if (n.name === 'exchange') for (const w of words) { const x = exchangeOf(w); venues.push(x.kind ? `${x.venue}/${x.kind}` : x.venue); }
    if (n.name === 'quote') for (const w of words) quotes.push(w.toUpperCase());
  }
  return { ...(kinds.length ? { kinds } : {}), ...(venues.length ? { venues } : {}), ...(quotes.length ? { quotes } : {}) };
}

/** The options' values a script runs with: those set, else the declared defaults (as script values). */
export function optionTable(declared: readonly OptionDecl[], optionValues: Readonly<Record<string, OptionValue>>): Record<string, Value> {
  const opt = plain();
  for (const d of declared) opt[d.name] = fromData(d.value);
  for (const [k, v] of Object.entries(optionValues)) opt[k] = fromData(v);
  return opt;
}

/** The sets of markets a script reads with these option values, by key ('' always there). */
export function sourcesWith(a: Pick<Analysis, 'sourceCalls' | 'declared'>, optionValues: Readonly<Record<string, OptionValue>>): Map<string, SourceFilter> {
  const opt = optionTable(a.declared, optionValues), out = new Map<string, SourceFilter>([['', {}]]);
  for (const c of a.sourceCalls) { const f = sourceFilter(c.named, opt); out.set(filterKey(f), f); }
  return out;
}

/**
 * The names a script keeps from candle to candle: those it assigns (`x = ...`) where no declaration reaches, neither one of the function the
 * assignment is in (its parameters, its `var`, `let`, `const` and functions) nor one outside every function.
 */
export function persistentNames(program: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  const declaredIn = (body: readonly Stmt[], params: readonly string[]): Set<string> => {
    const names = new Set(params);
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const n = x as Expr | Stmt;
      if ('k' in n) {
        if (n.k === 'fn') return;
        if (n.k === 'func') { names.add(n.name); return; }
        if (n.k === 'decl') for (const d of n.items) names.add(d.name);
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    };
    body.forEach(walk);
    return names;
  };
  const visit = (x: unknown, scopes: readonly Set<string>[]): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) visit(y, scopes); return; }
    const n = x as Expr | Stmt;
    if ('k' in n) {
      if (n.k === 'func' || n.k === 'fn') { const inner = [...scopes, declaredIn(n.body, n.params)]; visit(n.body, inner); return; }
      if (n.k === 'assign' && n.target.k === 'id') { const name = n.target.name; if (!KNOWN_INPUTS.has(name) && !scopes.some(sc => sc.has(name))) out.add(name); }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v, scopes);
  };
  visit(program, [declaredIn(program, [])]);
  return out;
}

/** Read a script without running it. Throws `ScriptSyntaxError` with where it went wrong. */
export function analyze(text: string): Analysis {
  try { return analyzeOnce(text); }
  catch (e) {
    // A script nested so deeply that reading it would overflow the stack is refused, wherever it is read (the page reads scripts too).
    if (e instanceof RangeError) throw new ScriptSyntaxError({ code: 'too-deep', line: 0, col: 0 });
    throw e;
  }
}
function analyzeOnce(text: string): Analysis {
  const program = parse(text);
  const declared = declaredNames(program);
  const persistent = persistentNames(program), options: OptionDecl[] = [], read = new Set<string>(), warnings: Warning[] = [];
  const sourceCalls: Extract<Expr, { k: 'call' }>[] = [], inputs = new Set<string>();
  const optionNames = new Set<string>();
  const visit = (node: unknown, top: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x, top); return; }
    const n = node as Expr | Stmt;
    if ('k' in n) {
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'options') read.add(n.name);
      if (n.k === 'call' && n.callee.k === 'id' && n.callee.name === 'source') sourceCalls.push(n);
      if (n.k === 'id' && (n.name === 'vbuy' || n.name === 'vsell' || n.name === 'lbuy' || n.name === 'lsell' || n.name === 'cbuy' || n.name === 'csell')) inputs.add(n.name);
      if (n.k === 'assign' && n.target.k === 'id' && n.value.k === 'call' && n.value.callee.k === 'id' && n.value.callee.name === 'option') {
        const name = n.target.name;
        if (!optionNames.has(name)) { optionNames.add(name); options.push(optionDecl(name, n.value)); }
      }
      if (n.k === 'decl') for (const d of n.items) if (d.init?.k === 'call' && d.init.callee.k === 'id' && d.init.callee.name === 'option' && !optionNames.has(d.name)) { optionNames.add(d.name); options.push(optionDecl(d.name, d.init)); }
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'renderer' && n.name !== 'length' && n.name !== 'timestamp') warnings.push({ code: 'unsupported-member', detail: `renderer.${n.name}` });
      if (n.k === 'id' && n.name.startsWith('$') && n.name !== '$price') warnings.push({ code: 'unknown-reference', detail: n.name });
      if (n.k === 'id' && (n.name === 'cbuy' || n.name === 'csell') && !warnings.some(w => w.code === 'no-counts')) warnings.push({ code: 'no-counts' });
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v, false);
  };
  visit(program, true);
  // What only a full browser engine has (the chart library's series objects, the raw function library): refused with where it is used.
  const refuse = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(refuse); return; }
    const x = node as Expr;
    if ('k' in x && x.k === 'id' && (x.name === 'series' || x.name === 'utils' || x.name === 'vars') && !declared.has(x.name) && !persistent.has(x.name)) throw new ScriptSyntaxError({ code: 'unsupported', line: x.p.line, col: x.p.col, detail: x.name });
    for (const v of Object.values(x)) if (v && typeof v === 'object') refuse(v);
  };
  refuse(program);
  const a = { program, persistent, sourceCalls, inputs, declared: options, read: [...read].filter(n => !optionNames.has(n)), warnings: dedupe(warnings), sources: new Map<string, SourceFilter>() };
  a.sources = sourcesWith(a, {});
  if (a.sources.size > MAX_SOURCES) { const c = sourceCalls[sourceCalls.length - 1]!; throw new ScriptSyntaxError({ code: 'too-many-sources', line: c.p.line, col: c.p.col }); }
  return a;
}

const dedupe = (w: Warning[]): Warning[] => w.filter((x, i) => w.findIndex(y => y.code === x.code && y.detail === x.detail) === i);

function optionDecl(name: string, call: Extract<Expr, { k: 'call' }>): OptionDecl {
  const arg = (k: string): OptionValue | undefined => { const n = call.named.find(x => x.name === k); return n ? literal(n.value) : undefined; };
  const def = arg('default') ?? (call.args[0] ? literal(call.args[0]) : undefined);
  const t = String(arg('type') ?? '').toLowerCase();
  const type: OptionDecl['type'] = t === 'color' ? 'color' : t === 'checkbox' || t === 'boolean' || t === 'bool' || typeof def === 'boolean' ? 'boolean' : t === 'list' ? 'list' : t === 'range' ? 'range' : t === 'text' || t === 'string' || (typeof def === 'string' && !/^(#|rgb|hsl)/i.test(def)) ? 'text' : typeof def === 'string' ? 'color' : 'number';
  // A default that is missing or false-like (0, false, '') is '' for a text, false for a switch, and the minimum (never under 0) for a number.
  const min = arg('min');
  const decl: OptionDecl = { name, type, value: def || (type === 'boolean' ? false : type === 'text' || type === 'color' || type === 'list' ? '' : Math.max(typeof min === 'number' ? min : 0, 0)) };
  const label = arg('label'); if (typeof label === 'string') decl.label = label;
  for (const k of ['min', 'max', 'step'] as const) { const v = arg(k); if (typeof v === 'number') decl[k] = v; }
  const choices = arg('options'); if (Array.isArray(choices)) decl.choices = choices;
  return decl;
}

/** What a run of a script keeps per plot while it goes from candle to candle. */
interface PlotBuild { kind: PlotKind; title: string; style: Record<string, OptionValue>; fields: Record<string, Float64Array>; colors: string[] | null }

/**
 * Run a script over every candle of `inputs`. `optionValues` are the values set for its options (a declared option not set reads its default).
 * Returns what to draw, or the first error with where it happened.
 */
export function runScript(id: string, source: string, optionValues: Record<string, OptionValue>, inputs: BarInputs, now: () => number = Date.now): ScriptResult {
  return createRunner(id, source, optionValues, now).run(inputs);
}

/** A script read once and run as often as its inputs change. */
export interface ScriptRunner {
  run(inputs: BarInputs): ScriptResult;
  /** The candle the last run started from: 0 for a run over every candle, more when only the candles after the last closed one ran again. */
  readonly startedAt: number;
}

const NO_INPUTS: BarInputs = { tf: 60_000, time: new Float64Array(0), open: new Float64Array(0), high: new Float64Array(0), low: new Float64Array(0), close: new Float64Array(0), volume: new Float64Array(0), sources: {}, forming: false };

/** Whether candles [0, m) of two inputs are the same (NaN where both are NaN): the only candles a run may take over from the one before. */
export function sameCandles(a: BarInputs, b: BarInputs, m: number): boolean {
  if (a.tf !== b.tf || m > a.time.length || m > b.time.length) return false;
  const ka = Object.keys(a.sources), kb = Object.keys(b.sources);
  if (ka.length !== kb.length || ka.some(k => !(k in b.sources))) return false;
  const eq = (x: Float64Array, y: Float64Array): boolean => { for (let k = 0; k < m; k++) { const u = x[k]!, v = y[k]!; if (u !== v && !(u !== u && v !== v)) return false; } return true; };
  if (!eq(a.time, b.time) || !eq(a.open, b.open) || !eq(a.high, b.high) || !eq(a.low, b.low) || !eq(a.close, b.close) || !eq(a.volume, b.volume)) return false;
  for (const k of ka) { const x = a.sources[k]!, y = b.sources[k]!; if (!eq(x.vbuy, y.vbuy) || !eq(x.vsell, y.vsell) || !eq(x.lbuy, y.lbuy) || !eq(x.lsell, y.lsell)) return false; }
  return true;
}

/** A copy of a script value deep enough that a later run cannot change it: the script's own arrays and objects copied, the rest shared (they do not change). */
function cloneValue(v: Value, seen = new Map<object, Value>()): Value {
  if (v === null || typeof v !== 'object') return v;
  const had = seen.get(v); if (had !== undefined) return had;
  if (Array.isArray(v)) { const out: Value[] = []; seen.set(v, out); for (const x of v) out.push(cloneValue(x, seen)); return out; }
  if (isPlain(v)) { const out = plain(); seen.set(v, out); for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x, seen); return out; }
  return v;
}
/** A copy of a stateful function's state (numbers, arrays and small objects of numbers). */
function cloneState(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneState);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cloneState(x);
  return out;
}

/**
 * Read a script once, and run it whenever its inputs change. A run over the same closed candles as the run before (the candle under way is the
 * only one that changed, or new ones were added after it) starts from what the script held after the last candle that had closed then, so a
 * live update runs one candle, not five hundred. Anything else (other candles, other markets, the timeframe) runs every candle from the first.
 */
export function createRunner(id: string, source: string, optionValues: Record<string, OptionValue>, now: () => number = Date.now): ScriptRunner {
  let a: Analysis;
  try { a = analyze(source); }
  catch (e) { if (e instanceof ScriptSyntaxError) { const info = e.info; return { run: () => ({ id, ok: false, error: info }), startedAt: 0 }; } throw e; }
  let inputs: BarInputs = NO_INPUTS;
  let n = 0;
  const budget: Budget = { steps: 0, left: 0, deadline: 0, now };
  // The options: what was set, else the declared default; plain data copied into the script's own values.
  const opt = optionTable(a.declared, optionValues);
  const optionsObject = new HostObject('options', k => opt[k], (k, v) => { opt[k] = v; return true; }, () => Object.keys(opt));

  // What persists: one value per name (any case: `Total` and `total` are one), starting at 0, and its value at the end of each candle (`name[n]`).
  const kept = new Map<string, { v: Value; past: Value[] }>();
  for (const name of a.persistent) kept.set(name.toLowerCase(), { v: 0, past: [] });
  const bindings = new Map<string, { get(): Value; set(v: Value): void }>();
  for (const [name, k] of kept) bindings.set(name, { get: () => k.v, set: v => { k.v = v; } });
  const byName = new Map<string, { get(): Value; set(v: Value): void } | null>();

  let i = 0;
  const sourceStack: string[] = [''];
  const src = (): SourceInputs | undefined => inputs.sources[sourceStack[sourceStack.length - 1]!] ?? inputs.sources[''];
  const at = (arr: Float64Array | undefined): number => arr ? arr[i]! : NaN;
  const price = { color: '' as string, borderColor: '', wickColor: '' };
  let candleColors: string[] = [];
  let colored = false;
  const priceObject = new HostObject('$price', k => {
    switch (k) {
      case 'open': return inputs.open[i]; case 'high': return inputs.high[i]; case 'low': return inputs.low[i]; case 'close': return inputs.close[i];
      case 'color': return price.color; case 'borderColor': return price.borderColor; case 'wickColor': return price.wickColor;
      case 'time': return inputs.time[i]! / 1000;
      default: return undefined;
    }
  }, (k, v) => { if (k === 'color' || k === 'borderColor' || k === 'wickColor') { price[k] = typeof v === 'string' ? v : ''; if (k === 'color') { candleColors[i] = price.color; colored = true; } return true; } return false; });
  const barObject = new HostObject('bar', k => {
    const s = src();
    switch (k) {
      case 'timestamp': return inputs.time[i]! / 1000;
      case 'vbuy': return at(s?.vbuy); case 'vsell': return at(s?.vsell); case 'lbuy': return at(s?.lbuy); case 'lsell': return at(s?.lsell);
      case 'cbuy': case 'csell': return NaN;
      case 'open': return inputs.open[i]; case 'high': return inputs.high[i]; case 'low': return inputs.low[i]; case 'close': return inputs.close[i];
      default: return undefined;
    }
  });
  const rendererObject = new HostObject('renderer', k => {
    switch (k) {
      case 'length': return i + 1;
      case 'timestamp': case 'localTimestamp': return inputs.time[i]! / 1000;
      case 'timeframe': return inputs.tf / 1000;
      case 'type': return 'time';
      case 'lastTradeTimestamp': return i === n - 1 && inputs.forming ? now() / 1000 : (inputs.time[i]! + inputs.tf) / 1000;
      default: return undefined;
    }
  });

  // The language's state per place in the text: functions (`sma` at line 3 is not `sma` at line 5), plots, and the order `fns[k]` counts them in.
  const instances = new Map<number, Instance>();
  const touched: Instance[] = [];
  const plots = new Map<number, PlotBuild>();
  const plotOrder: number[] = [];

  // `fns[k]` is the k-th call of a function that keeps state, in the order they are written; setting its `state` starts it again.
  const builtinSites: number[] = [];
  for (const [node, site] of numberSites(a.program)) if (node.k === 'call' && node.callee.k === 'id' && own(BUILTINS, node.callee.name)) builtinSites.push(site);
  const instanceAt = (site: number): Instance => { let inst = instances.get(site); if (!inst) { inst = makeInstance(); instances.set(site, inst); } return inst; };
  const fnsObject = new HostObject('fns', k => {
    const site = builtinSites[Number(k)];
    if (site === undefined) return undefined;
    return new HostObject('fn', key => key === 'state' ? plain() : undefined, key => { if (key !== 'state') return false; instanceAt(site).reset(); return true; });
  });

  // Without a prototype: `toString` or `constructor` are not names the table holds.
  const globals: Record<string, Value> = Object.assign(Object.create(null) as Record<string, Value>, {
    Math: mathObject(), Number: numberObject(), Infinity, NaN, undefined,
    String: new NativeFunction('String', args => text(args[0])), Boolean: new NativeFunction('Boolean', args => truthy(args[0])),
    isFinite: new NativeFunction('isFinite', args => Number.isFinite(num(args[0]))), isNaN: new NativeFunction('isNaN', args => Number.isNaN(num(args[0]))),
    parseFloat: new NativeFunction('parseFloat', args => parseFloat(text(args[0]))), parseInt: new NativeFunction('parseInt', args => parseInt(text(args[0]), args[1] === undefined ? 10 : num(args[1]))),
    Date: dateObject(now), Array: arrayObject(n => charge(budget, n)), Object: objectObject(),
    rgb: new NativeFunction('rgb', args => rgb(args.map(num))), rgba: new NativeFunction('rgba', args => rgb(args.map(num))),
    nz: new NativeFunction('nz', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)) ? (args.length > 1 ? args[1] : 0) : v; }),
    na: new NativeFunction('na', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)); }),
    option: new NativeFunction('option', () => undefined),
    source: new NativeFunction('source', () => undefined),
  });
  for (const name of Object.keys(BUILTINS)) globals[name] = new NativeFunction(name, () => undefined);
  for (const name of Object.keys(PLOTS)) if (!Object.prototype.hasOwnProperty.call(globals, name)) globals[name] = new NativeFunction(name, () => undefined);

  const host: Host = {
    global(name) {
      switch (name) {
        case 'time': return { known: true, value: inputs.time[i]! / 1000 };
        case 'vbuy': return { known: true, value: at(src()?.vbuy) };
        case 'vsell': return { known: true, value: at(src()?.vsell) };
        case 'lbuy': return { known: true, value: at(src()?.lbuy) };
        case 'lsell': return { known: true, value: at(src()?.lsell) };
        case 'cbuy': case 'csell': return { known: true, value: NaN };
        case 'bar': return { known: true, value: barObject };
        case '$price': return { known: true, value: priceObject };
        case 'options': return { known: true, value: optionsObject };
        case 'renderer': return { known: true, value: rendererObject };
        case 'fns': return { known: true, value: fnsObject };
      }
      if (Object.prototype.hasOwnProperty.call(globals, name)) return { known: true, value: globals[name] };
      const color = own(COLOR_NAMES, name.toLowerCase());
      if (color !== undefined) return { known: true, value: color };
      return { known: false, value: undefined };
    },
    persistent: name => { let b = byName.get(name); if (b === undefined) { b = bindings.get(name.toLowerCase()) ?? null; byName.set(name, b); } return b; },
    history(name, back) {
      const k = kept.get(name.toLowerCase());
      // A kept array or object is indexed as one (`levels[0]`); only a kept number or text has a history.
      if (!k || Array.isArray(k.v) || isPlain(k.v)) return null;
      if (!Number.isInteger(back) || back < 0) return { value: undefined };
      if (back === 0) return { value: k.v };
      // Further back than has been kept reads the oldest there is (on the first candle `x[1]` is `x` itself).
      return { value: k.past.length ? k.past[Math.max(0, k.past.length - back)] : k.v };
    },
    callNative(fn, args, named, site, node) {
      const name = fn.name;
      if (node.callee.k !== 'id') return fn.call(args, named);
      if (name === 'option') { const target = optionTarget(node); return target !== null ? opt[target] : args[0] ?? named?.default; }
      if (name === 'source') return args[0];
      const plotKind = own(PLOTS, name);
      if (plotKind) { plot(site, plotKind, args, named); return undefined; }
      const builtin = own(BUILTINS, name);
      if (builtin) {
        const inst = instanceAt(site);
        if (!inst.touched) { inst.touched = true; touched.push(inst); }
        return builtin(inst, args, named, { open: inputs.open[i]!, high: inputs.high[i]!, low: inputs.low[i]!, close: inputs.close[i]! });
      }
      return fn.call(args, named);
    },
  };

  // `source(expr, ...)`: the inputs inside `expr` are read over the call's markets. The argument is evaluated by the interpreter, so the
  // interpreter is told which set to read while it does: the call is found by its place, before its arguments are read.
  const sourceSites = new Map<Expr, string>();
  const sites = numberSites(a.program);
  for (const node of sites.keys()) if (node.k === 'call' && node.callee.k === 'id' && node.callee.name === 'source') sourceSites.set(node, filterKey(sourceFilter(node.named, opt)));
  const optionTargets = new Map<Expr, string>();
  const noteTargets = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(noteTargets); return; }
    const x = node as Expr | Stmt;
    if ('k' in x) {
      if (x.k === 'assign' && x.target.k === 'id' && x.value.k === 'call') optionTargets.set(x.value, x.target.name);
      if (x.k === 'decl') for (const d of x.items) if (d.init?.k === 'call') optionTargets.set(d.init, d.name);
    }
    for (const v of Object.values(x)) if (v && typeof v === 'object') noteTargets(v);
  };
  noteTargets(a.program);
  const optionTarget = (node: Expr): string | null => optionTargets.get(node) ?? null;

  // Every plot call in the text is one plot, in the order written, whether or not it ever runs (one inside an `if` that is never true stays
  // empty). Its style starts from the named arguments that can be read without running the script (literals, options), and the first call
  // that runs adds what it gives.
  const styled = new Set<number>();
  const scriptNames = new Set([...declaredNames(a.program), ...a.persistent]);
  for (const [node, site] of sites) {
    if (node.k !== 'call' || node.callee.k !== 'id') continue;
    const kind = own(PLOTS, node.callee.name);
    if (!kind) continue;
    if (plots.size >= MAX_PLOTS) { const error = { code: 'too-many-plots', line: node.p.line, col: node.p.col }; return { run: () => ({ id, ok: false, error }), startedAt: 0 }; }
    const fields: Record<string, Float64Array> = {};
    for (const f of PLOT_FIELDS[kind]) fields[f] = new Float64Array(n).fill(NaN);
    const style: Record<string, OptionValue> = {};
    for (const nm of node.named) { const v = staticValue(nm.value, opt, scriptNames); if (v !== undefined) style[nm.name] = v; }
    plots.set(site, { kind, title: typeof style.title === 'string' ? style.title : typeof style.title === 'number' ? String(style.title) : '', style, fields, colors: null });
    plotOrder.push(site);
  }

  function plot(site: number, kind: PlotKind, args: Value[], named: Record<string, Value> | null): void {
    const p = plots.get(site);
    if (!p || p.kind !== kind) return;
    if (named && !styled.has(site)) {
      styled.add(site);
      for (const [k, v] of Object.entries(named)) { const d = toData(v); if (d !== undefined && !(k in p.style)) p.style[k] = d; }
      if (!p.title && typeof named.title === 'string') p.title = named.title;
    }
    // A call with no value (only named arguments) makes its plot and draws nothing.
    if (!args.length) return;
    const point = args[0];
    const setColor = (c: Value): void => { if (typeof c === 'string' && c) { if (!p!.colors) p!.colors = new Array<string>(n).fill(''); p!.colors[i] = c; } };
    if (isPlain(point)) {
      for (const f of PLOT_FIELDS[kind]) { const v = point[f]; p.fields[f]![i] = typeof v === 'number' ? v : v === undefined || v === null ? NaN : num(v); }
      if (kind === 'line' || kind === 'area' || kind === 'histogram' || kind === 'baseline') { if (point.value === undefined && typeof point.close === 'number') p.fields.value![i] = point.close; }
      setColor(point.color);
      return;
    }
    const fields = PLOT_FIELDS[kind];
    for (let f = 0; f < fields.length; f++) { const v = args[f]; p.fields[fields[f]!]![i] = typeof v === 'number' ? v : v === undefined || v === null ? NaN : num(v); }
    if (named && typeof named.color === 'string' && kind === 'histogram') setColor(named.color);
  }
  /** A histogram bar of 0 is not drawn (an empty candle leaves no stub). */
  const dropZeros = (): void => { for (const p of plots.values()) if (p.kind === 'histogram') { const v = p.fields.value!; for (let k = 0; k < n; k++) if (v[k] === 0) v[k] = NaN; } };

  // The interpreter evaluates a call's arguments before the host sees the call: `source` puts its set in place before its arguments are read.
  host.aroundCall = (node, run) => {
    const key = sourceSites.get(node);
    if (key === undefined) return run();
    sourceStack.push(key);
    try { return run(); } finally { sourceStack.pop(); }
  };
  // A plot's named arguments are its style, read on its first call; `source`, `option` and the stateful functions take theirs from the text.
  host.wantsNamed = (fn, site) => own(PLOTS, fn.name) !== undefined ? !styled.has(site) : !(fn.name === 'source' || fn.name === 'option' || own(BUILTINS, fn.name));
  host.construct = (name, args) => {
    if (name === 'Date') return new DateValue(args.length ? (args[0] instanceof DateValue ? args[0].ms : num(args[0])) : now());
    const len = num(args[0]);
    if (args.length === 1 && Number.isInteger(len) && len >= 0 && len <= 1_000_000) { charge(budget, len); return new Array<Value>(len).fill(undefined); }
    if (args.length === 1 && typeof args[0] === 'number') throw new ScriptRuntimeError('too-large', 0, 0, 'array');
    return [...args];
  };
  const interp = new Interpreter(a.program, host, budget);

  /** What the script held after candle `at` of `inputs` had closed, and what it had drawn by then. */
  interface Snapshot { at: number; inputs: BarInputs; kept: Map<string, { v: Value; past: Value[] }>; states: Map<number, unknown>; fields: Map<number, Record<string, Float64Array>>; colors: Map<number, string[] | null>; candleColors: string[] }
  let snap: Snapshot | null = null;
  const take = (at: number): Snapshot => ({
    at, inputs,
    kept: new Map([...kept].map(([name, k]) => [name, { v: cloneValue(k.v), past: k.past.map(x => cloneValue(x)) }])),
    states: new Map([...instances].map(([site, inst]) => [site, cloneState(inst.state)])),
    fields: new Map([...plots].map(([site, p]) => [site, p.fields])),
    colors: new Map([...plots].map(([site, p]) => [site, p.colors])),
    candleColors,
  });
  /** Put back what the script held after candle `snap.at`. */
  const restore = (from: Snapshot): void => {
    for (const [name, k] of kept) { const was = from.kept.get(name); k.v = was ? cloneValue(was.v) : 0; k.past = was ? was.past.map(x => cloneValue(x)) : []; }
    for (const [site, inst] of instances) { inst.pending = null; inst.touched = false; inst.state = from.states.has(site) ? cloneState(from.states.get(site)) as Record<string, unknown> : {}; }
  };
  /** Start from nothing: every kept name at 0, every function's state empty. */
  const fresh = (): void => {
    for (const k of kept.values()) { k.v = 0; k.past = []; }
    instances.clear();
  };

  const runner = {
    startedAt: 0,
    run(next: BarInputs): ScriptResult {
      const started = now();
      inputs = next; n = next.time.length;
      // From the candle after the last one that had closed at the run before, when every candle before it is the same.
      const start = snap && snap.at === snap.inputs.time.length - 2 && snap.at + 1 <= n && sameCandles(snap.inputs, next, snap.at + 1) ? snap.at + 1 : 0;
      const from = start > 0 ? snap : null;
      if (from) restore(from); else { fresh(); snap = null; }
      runner.startedAt = start;
      budget.steps = 0; budget.left = Math.max(200_000, STEPS_PER_CANDLE * (n - start)); budget.deadline = started + RUN_MS;
      const warnings = [...a.warnings];
      // The plots' numbers: those of the candles taken over, then NaN until the run gives them.
      for (const [site, p] of plots) {
        const fields: Record<string, Float64Array> = {};
        for (const f of PLOT_FIELDS[p.kind]) { const arr = new Float64Array(n).fill(NaN); const old = from?.fields.get(site)?.[f]; if (old) arr.set(old.subarray(0, start)); fields[f] = arr; }
        p.fields = fields;
        const oldColors = from?.colors.get(site) ?? null;
        p.colors = oldColors ? [...oldColors.slice(0, start), ...new Array<string>(n - start).fill('')] : null;
      }
      candleColors = from ? from.candleColors.slice(0, start) : [];
      colored = candleColors.some(c => c);
      try {
        for (i = start; i < n; i++) {
          price.color = ''; price.borderColor = ''; price.wickColor = '';
          interp.runOnce();
          for (const inst of touched) { inst.commit(); inst.touched = false; }
          touched.length = 0;
          for (const k of kept.values()) { k.past.push(k.v); if (k.past.length > 4_096) k.past.splice(0, k.past.length - 2_048); }
          // After the last candle that has closed: what the next run over the same candles starts from.
          if (i === n - 2) snap = take(i);
        }
      } catch (e) {
        snap = null;
        if (e instanceof ScriptRuntimeError) return { id, ok: false, error: { code: e.code, line: e.line, col: e.col, ...(e.detail ? { detail: e.detail } : {}) } };
        if (e instanceof RangeError) return { id, ok: false, error: { code: 'too-deep', line: 0, col: 0 } };
        throw e;
      }
      // A run of the candle under way alone keeps the snapshot of the run before (its closed candles are the same); a run over no closed candle has none.
      if (n < 2) snap = null;
      dropZeros();
      const out: PlotOut[] = plotOrder.map(site => { const p = plots.get(site)!; return { kind: p.kind, title: p.title, style: p.style, fields: p.fields, colors: p.colors }; });
      if (!out.length && !colored) warnings.push({ code: 'no-plots' });
      return { id, ok: true, plots: out, warnings, steps: budget.steps, ms: now() - started, ...(colored ? { candleColors: Array.from({ length: n }, (_, k) => candleColors[k] ?? '') } : {}) };
    },
  };
  return runner;
}

function mathObject(): HostObject {
  const fns: Record<string, (...a: number[]) => number> = {
    abs: Math.abs, max: Math.max, min: Math.min, sqrt: Math.sqrt, pow: Math.pow, log: Math.log, log10: Math.log10, log2: Math.log2, log1p: Math.log1p, exp: Math.exp, expm1: Math.expm1,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc, sign: Math.sign, cbrt: Math.cbrt, hypot: Math.hypot,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    random: Math.random,
  };
  const consts: Record<string, number> = { PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2 };
  const made = new Map<string, NativeFunction>();
  return new HostObject('Math', k => {
    const c = own(consts, k); if (c !== undefined) return c;
    const f = own(fns, k); if (!f) return undefined;
    let nf = made.get(k);
    if (!nf) { nf = new NativeFunction(k, args => f(...args.map(num))); made.set(k, nf); }
    return nf;
  });
}

function numberObject(): NativeFunction {
  const consts: Record<string, number> = { EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN };
  const fns: Record<string, NativeFunction> = {
    isFinite: new NativeFunction('isFinite', a => typeof a[0] === 'number' && Number.isFinite(a[0])),
    isNaN: new NativeFunction('isNaN', a => typeof a[0] === 'number' && Number.isNaN(a[0])),
    isInteger: new NativeFunction('isInteger', a => typeof a[0] === 'number' && Number.isInteger(a[0])),
    parseFloat: new NativeFunction('parseFloat', a => parseFloat(text(a[0]))),
    parseInt: new NativeFunction('parseInt', a => parseInt(text(a[0]), a[1] === undefined ? 10 : num(a[1]))),
  };
  const members = new HostObject('Number', k => own(consts, k) ?? own(fns, k));
  return new NativeFunction('Number', a => a.length ? num(a[0]) : 0, null, members);
}

function dateObject(now: () => number): HostObject {
  return new HostObject('Date', k => k === 'now' ? new NativeFunction('now', () => now()) : k === 'UTC' ? new NativeFunction('UTC', a => Date.UTC(num(a[0]), num(a[1] ?? 0), num(a[2] ?? 1), num(a[3] ?? 0), num(a[4] ?? 0), num(a[5] ?? 0))) : undefined);
}
function arrayObject(pay: (n: number) => void): HostObject {
  const from = (a: Value[]): Value[] => {
    if (Array.isArray(a[0])) { pay(a[0].length); return [...a[0]]; }
    const n = isPlain(a[0]) && typeof a[0].length === 'number' ? Math.max(0, Math.min(Math.floor(a[0].length), 1_000_000)) : 0;
    pay(n);
    return new Array<Value>(Number.isFinite(n) ? n : 0).fill(undefined);
  };
  return new HostObject('Array', k => k === 'isArray' ? new NativeFunction('isArray', a => Array.isArray(a[0])) : k === 'from' ? new NativeFunction('from', from) : undefined);
}
function objectObject(): HostObject {
  const own = (v: Value): [string, Value][] => isPlain(v) ? Object.entries(v) : Array.isArray(v) ? v.map((x, i) => [String(i), x] as [string, Value]) : v instanceof HostObject && v.keys ? v.keys().map(k => [k, v.get(k)] as [string, Value]) : [];
  return new HostObject('Object', k => {
    if (k === 'keys') return new NativeFunction('keys', a => own(a[0]).map(e => e[0]));
    if (k === 'values') return new NativeFunction('values', a => own(a[0]).map(e => e[1]));
    if (k === 'entries') return new NativeFunction('entries', a => own(a[0]).map(e => [e[0], e[1]]));
    if (k === 'assign') return new NativeFunction('assign', a => { const t = a[0]; if (!isPlain(t)) return t; for (const s of a.slice(1)) for (const [kk, v] of own(s)) if (kk !== '__proto__') t[kk] = v; return t; });
    return undefined;
  });
}

export { DateValue, interpolateColors };
export type { ScriptError };
