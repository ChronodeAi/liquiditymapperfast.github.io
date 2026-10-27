import { parse, type Expr, type Stmt } from './parser.ts';
import { ScriptSyntaxError, type ScriptError } from './lexer.ts';
import { Interpreter, declaredNames, numberSites, type Budget, type Host } from './interpreter.ts';
import { DateValue, HostObject, NativeFunction, ScriptRuntimeError, fromData, isPlain, num, plain, text, toData, truthy, type Value } from './values.ts';
import { BUILTINS, makeInstance, type Instance } from './builtins.ts';
import { COLOR_NAMES, interpolateColors, rgb } from './colors.ts';
import { PLOT_FIELDS, type OptionDecl, type PlotKind, type PlotOut, type ScriptResult, type Warning } from './protocol.ts';
import { filterKey, type BarInputs, type SourceFilter, type SourceInputs } from './inputs.ts';
import type { OptionValue } from './records.ts';

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
  return table[n] ?? { venue: n.toLowerCase().replace(/_futures$/, '') };
}

/** A literal value of a call's named argument read without running the script (a number, a text, a plain word, true/false, `rgb(...)`), or undefined. */
function literal(e: Expr): OptionValue | undefined {
  if (e.k === 'num' || e.k === 'str') return e.v;
  if (e.k === 'id') return e.name === 'true' ? true : e.name === 'false' ? false : e.name === 'null' ? null : COLOR_NAMES[e.name.toLowerCase()] ?? e.name;
  if (e.k === 'un' && e.op === '-' && e.arg.k === 'num') return -e.arg.v;
  if (e.k === 'call' && e.callee.k === 'id' && (e.callee.name === 'rgb' || e.callee.name === 'rgba') && e.args.every(a => a.k === 'num' || (a.k === 'un' && a.arg.k === 'num'))) return rgb(e.args.map(a => Number(literal(a))));
  if (e.k === 'arr') { const items = e.items.map(literal); return items.every(x => x !== undefined) ? items as OptionValue[] : undefined; }
  return undefined;
}

/** A `source(...)` call's filter from its named arguments (`type`, `exchange`, `quote`; more than one exchange as `exchange=A+B` or repeated calls). */
export function sourceFilter(named: readonly { name: string; value: Expr }[]): SourceFilter {
  const kinds: ('spot' | 'perp')[] = [], venues: string[] = [], quotes: string[] = [];
  for (const n of named) {
    const v = literal(n.value);
    if (typeof v !== 'string') continue;
    const words = v.split(/[+,|\s]+/).filter(Boolean);
    if (n.name === 'type') for (const w of words) { const k = w.toLowerCase(); if (k === 'spot') kinds.push('spot'); else if (k === 'perp' || k === 'perpetual' || k === 'futures' || k === 'linear' || k === 'inverse') kinds.push('perp'); }
    if (n.name === 'exchange') for (const w of words) { const x = exchangeOf(w); venues.push(x.kind ? `${x.venue}/${x.kind}` : x.venue); }
    if (n.name === 'quote') for (const w of words) quotes.push(w.toUpperCase());
  }
  return { ...(kinds.length ? { kinds } : {}), ...(venues.length ? { venues } : {}), ...(quotes.length ? { quotes } : {}) };
}

/** Read a script without running it. Throws `ScriptSyntaxError` with where it went wrong. */
export function analyze(text: string): Analysis {
  const program = parse(text);
  const declared = declaredNames(program);
  const persistent = new Set<string>(), sources = new Map<string, SourceFilter>([['', {}]]), options: OptionDecl[] = [], read = new Set<string>(), warnings: Warning[] = [];
  const optionNames = new Set<string>();
  const visit = (node: unknown, top: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x, top); return; }
    const n = node as Expr | Stmt;
    if ('k' in n) {
      if (n.k === 'assign' && n.target.k === 'id' && !declared.has(n.target.name) && !KNOWN_INPUTS.has(n.target.name)) persistent.add(n.target.name);
      if (n.k === 'member' && n.obj.k === 'id' && n.obj.name === 'options') read.add(n.name);
      if (n.k === 'call' && n.callee.k === 'id' && n.callee.name === 'source') {
        const f = sourceFilter(n.named), key = filterKey(f);
        if (!sources.has(key)) { if (sources.size >= MAX_SOURCES) throw new ScriptSyntaxError({ code: 'too-many-sources', line: n.p.line, col: n.p.col }); sources.set(key, f); }
      }
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
  return { program, persistent, sources, declared: options, read: [...read].filter(n => !optionNames.has(n)), warnings: dedupe(warnings) };
}

const dedupe = (w: Warning[]): Warning[] => w.filter((x, i) => w.findIndex(y => y.code === x.code && y.detail === x.detail) === i);

function optionDecl(name: string, call: Extract<Expr, { k: 'call' }>): OptionDecl {
  const arg = (k: string): OptionValue | undefined => { const n = call.named.find(x => x.name === k); return n ? literal(n.value) : undefined; };
  const def = arg('default') ?? (call.args[0] ? literal(call.args[0]) : undefined);
  const t = String(arg('type') ?? '').toLowerCase();
  const type: OptionDecl['type'] = t === 'color' ? 'color' : t === 'checkbox' || t === 'boolean' || t === 'bool' || typeof def === 'boolean' ? 'boolean' : t === 'list' ? 'list' : t === 'range' ? 'range' : t === 'text' || t === 'string' || (typeof def === 'string' && !/^(#|rgb|hsl)/i.test(def)) ? 'text' : typeof def === 'string' ? 'color' : 'number';
  const decl: OptionDecl = { name, type, value: def ?? (type === 'boolean' ? false : type === 'number' || type === 'range' ? 0 : '') };
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
  let a: Analysis;
  try { a = analyze(source); }
  catch (e) { if (e instanceof ScriptSyntaxError) return { id, ok: false, error: e.info }; throw e; }
  const started = now();
  const n = inputs.time.length;
  const budget: Budget = { steps: 0, left: Math.max(200_000, STEPS_PER_CANDLE * n), deadline: started + RUN_MS, now };
  const warnings = [...a.warnings];
  // The options: what was set, else the declared default; plain data copied into the script's own values.
  const opt = plain();
  for (const d of a.declared) opt[d.name] = fromData(d.value);
  for (const [k, v] of Object.entries(optionValues)) opt[k] = fromData(v);
  const optionsObject = new HostObject('options', k => opt[k], (k, v) => { opt[k] = v; return true; }, () => Object.keys(opt));

  // What persists: one value per name, and its value at the end of each candle (for `name[n]`).
  const kept = new Map<string, { v: Value; past: Value[] }>();
  for (const name of a.persistent) kept.set(name, { v: undefined, past: [] });
  const bindings = new Map<string, { get(): Value; set(v: Value): void }>();
  for (const [name, k] of kept) bindings.set(name, { get: () => k.v, set: v => { k.v = v; } });

  let i = 0;
  const sourceStack: string[] = [''];
  const src = (): SourceInputs | undefined => inputs.sources[sourceStack[sourceStack.length - 1]!] ?? inputs.sources[''];
  const at = (arr: Float64Array | undefined): number => arr ? arr[i]! : NaN;
  const price = { color: '' as string, borderColor: '', wickColor: '' };
  const candleColors: string[] = [];
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
  const rendererObject = new HostObject('renderer', k => k === 'length' ? i + 1 : k === 'timestamp' ? inputs.time[i]! / 1000 : undefined);

  // The language's state per place in the text: functions (`sma` at line 3 is not `sma` at line 5), plots, and the order `fns[k]` counts them in.
  const instances = new Map<number, Instance>();
  const touched: Instance[] = [];
  const plots = new Map<number, PlotBuild>();
  const plotOrder: number[] = [];

  // `fns[k]` is the k-th call of a function that keeps state, in the order they are written; setting its `state` starts it again.
  const builtinSites: number[] = [];
  for (const [node, site] of numberSites(a.program)) if (node.k === 'call' && node.callee.k === 'id' && BUILTINS[node.callee.name]) builtinSites.push(site);
  const instanceAt = (site: number): Instance => { let inst = instances.get(site); if (!inst) { inst = makeInstance(); instances.set(site, inst); } return inst; };
  const fnsObject = new HostObject('fns', k => {
    const site = builtinSites[Number(k)];
    if (site === undefined) return undefined;
    return new HostObject('fn', key => key === 'state' ? plain() : undefined, key => { if (key !== 'state') return false; instanceAt(site).reset(); return true; });
  });

  const globals: Record<string, Value> = {
    Math: mathObject(), Number: numberObject(), Infinity, NaN, undefined,
    String: new NativeFunction('String', args => text(args[0])), Boolean: new NativeFunction('Boolean', args => truthy(args[0])),
    isFinite: new NativeFunction('isFinite', args => Number.isFinite(num(args[0]))), isNaN: new NativeFunction('isNaN', args => Number.isNaN(num(args[0]))),
    parseFloat: new NativeFunction('parseFloat', args => parseFloat(text(args[0]))), parseInt: new NativeFunction('parseInt', args => parseInt(text(args[0]), args[1] === undefined ? 10 : num(args[1]))),
    Date: dateObject(now), Array: arrayObject(), Object: objectObject(),
    rgb: new NativeFunction('rgb', args => rgb(args.map(num))), rgba: new NativeFunction('rgba', args => rgb(args.map(num))),
    nz: new NativeFunction('nz', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)) ? (args.length > 1 ? args[1] : 0) : v; }),
    na: new NativeFunction('na', args => { const v = args[0]; return v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v)); }),
    option: new NativeFunction('option', () => undefined),
    source: new NativeFunction('source', () => undefined),
  };
  for (const name of Object.keys(BUILTINS)) globals[name] = new NativeFunction(name, () => undefined);
  for (const name of Object.keys(PLOTS)) if (!(name in globals)) globals[name] = new NativeFunction(name, () => undefined);

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
      if (name in globals) return { known: true, value: globals[name] };
      const color = COLOR_NAMES[name.toLowerCase()];
      if (color !== undefined) return { known: true, value: color };
      return { known: false, value: undefined };
    },
    persistent: name => bindings.get(name) ?? null,
    history(name, back) {
      const k = kept.get(name);
      // A kept array or object is indexed as one (`levels[0]`); only a kept number or text has a history.
      if (!k || Array.isArray(k.v) || isPlain(k.v)) return null;
      if (!Number.isInteger(back) || back < 0) return { value: undefined };
      if (back === 0) return { value: k.v };
      return { value: k.past[k.past.length - back] };
    },
    callNative(fn, args, named, site, node) {
      const name = fn.name;
      if (node.callee.k !== 'id') return fn.call(args, named);
      if (name === 'option') { const target = optionTarget(node); return target !== null ? opt[target] : args[0] ?? named?.default; }
      if (name === 'source') return args[0];
      const plotKind = PLOTS[name];
      if (plotKind) { plot(site, plotKind, args, named); return undefined; }
      const builtin = BUILTINS[name];
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
  for (const node of sites.keys()) if (node.k === 'call' && node.callee.k === 'id' && node.callee.name === 'source') sourceSites.set(node, filterKey(sourceFilter(node.named)));
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

  function plot(site: number, kind: PlotKind, args: Value[], named: Record<string, Value> | null): void {
    let p = plots.get(site);
    if (!p) {
      if (plots.size >= MAX_PLOTS) throw new ScriptRuntimeError('too-many-plots');
      const fields: Record<string, Float64Array> = {};
      for (const f of PLOT_FIELDS[kind]) fields[f] = new Float64Array(n).fill(NaN);
      const style: Record<string, OptionValue> = {};
      if (named) for (const [k, v] of Object.entries(named)) { const d = toData(v); if (d !== undefined) style[k] = d; }
      p = { kind, title: typeof named?.title === 'string' ? named.title : '', style, fields, colors: null };
      plots.set(site, p); plotOrder.push(site);
    }
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

  // The interpreter evaluates a call's arguments before the host sees the call: `source` puts its set in place before its arguments are read.
  host.aroundCall = (node, run) => {
    const key = sourceSites.get(node);
    if (key === undefined) return run();
    sourceStack.push(key);
    try { return run(); } finally { sourceStack.pop(); }
  };
  host.construct = (name, args) => {
    if (name === 'Date') return new DateValue(args.length ? (args[0] instanceof DateValue ? args[0].ms : num(args[0])) : now());
    const len = num(args[0]);
    if (args.length === 1 && Number.isInteger(len) && len >= 0 && len <= 1_000_000) return new Array<Value>(len).fill(undefined);
    if (args.length === 1 && typeof args[0] === 'number') throw new ScriptRuntimeError('too-large', 0, 0, 'array');
    return [...args];
  };
  const interp = new Interpreter(a.program, host, budget);

  try {
    for (i = 0; i < n; i++) {
      interp.runOnce();
      for (const inst of touched) { inst.commit(); inst.touched = false; }
      touched.length = 0;
      for (const k of kept.values()) { k.past.push(k.v); if (k.past.length > 4_096) k.past.splice(0, k.past.length - 2_048); }
    }
  } catch (e) {
    if (e instanceof ScriptRuntimeError) return { id, ok: false, error: { code: e.code, line: e.line, col: e.col, ...(e.detail ? { detail: e.detail } : {}) } };
    if (e instanceof RangeError) return { id, ok: false, error: { code: 'too-deep', line: 0, col: 0 } };
    throw e;
  }
  const out: PlotOut[] = plotOrder.map(site => { const p = plots.get(site)!; return { kind: p.kind, title: p.title, style: p.style, fields: p.fields, colors: p.colors }; });
  if (!out.length && !colored) warnings.push({ code: 'no-plots' });
  return { id, ok: true, plots: out, warnings, steps: budget.steps, ms: now() - started, ...(colored ? { candleColors: Array.from({ length: n }, (_, k) => candleColors[k] ?? '') } : {}) };
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
    if (k in consts) return consts[k];
    const f = fns[k]; if (!f) return undefined;
    let nf = made.get(k);
    if (!nf) { nf = new NativeFunction(k, args => f(...args.map(num))); made.set(k, nf); }
    return nf;
  });
}

function numberObject(): HostObject {
  const consts: Record<string, number> = { EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN };
  const fns: Record<string, NativeFunction> = {
    isFinite: new NativeFunction('isFinite', a => typeof a[0] === 'number' && Number.isFinite(a[0])),
    isNaN: new NativeFunction('isNaN', a => typeof a[0] === 'number' && Number.isNaN(a[0])),
    isInteger: new NativeFunction('isInteger', a => typeof a[0] === 'number' && Number.isInteger(a[0])),
    parseFloat: new NativeFunction('parseFloat', a => parseFloat(text(a[0]))),
    parseInt: new NativeFunction('parseInt', a => parseInt(text(a[0]), a[1] === undefined ? 10 : num(a[1]))),
  };
  const call = new NativeFunction('Number', a => num(a[0]));
  return new HostObject('Number', k => k in consts ? consts[k] : fns[k] ?? (k === 'call' ? call : undefined));
}

function dateObject(now: () => number): HostObject {
  return new HostObject('Date', k => k === 'now' ? new NativeFunction('now', () => now()) : k === 'UTC' ? new NativeFunction('UTC', a => Date.UTC(num(a[0]), num(a[1] ?? 0), num(a[2] ?? 1), num(a[3] ?? 0), num(a[4] ?? 0), num(a[5] ?? 0))) : undefined);
}
function arrayObject(): HostObject {
  return new HostObject('Array', k => k === 'isArray' ? new NativeFunction('isArray', a => Array.isArray(a[0])) : k === 'from' ? new NativeFunction('from', a => Array.isArray(a[0]) ? [...a[0]] : isPlain(a[0]) && typeof a[0].length === 'number' ? Array.from({ length: Math.min(num(a[0].length), 1_000_000) }, () => undefined) : []) : undefined);
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
