import { isPlain, num, plain, type Value } from './values.ts';
import { interpolateColors } from './colors.ts';

/**
 * The language's functions that keep state from candle to candle (`sma`, `ema`, `cum`, ...). Each place a script calls one has its own
 * instance. A call works out the value for the candle from what the instance holds and the value given, and leaves what it would add as
 * `pending`; the candle's end commits it. A function called twice in one candle (in a loop) answers from the same state both times and keeps
 * the last call's addition, so a candle counts once. A value that is not a number (NaN: a candle not recorded) gives NaN and adds nothing,
 * so an average starts where the data does instead of being poisoned by it.
 */

export interface Instance {
  state: Record<string, unknown>;
  pending: (() => void) | null;
  touched: boolean;
  commit(): void;
  /** Start again, as at the first candle (`fns[k].state = {}`). */
  reset(): void;
}
export function makeInstance(): Instance {
  const inst: Instance = {
    state: {}, pending: null, touched: false,
    commit() { const p = inst.pending; inst.pending = null; p?.(); },
    reset() { inst.state = {}; inst.pending = null; },
  };
  return inst;
}

/** The chart's candle a function like `avg_ohlc(bar)` reads. */
export interface Candle { open: number; high: number; low: number; close: number }
export type Builtin = (inst: Instance, args: Value[], named: Record<string, Value> | null, candle: Candle) => Value;

const len = (v: Value, fallback = 14): number => { const n = Math.floor(num(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 10_000) : fallback; };
const finite = (v: number): boolean => Number.isFinite(v);

/** The last `n - 1` values committed (a window that the current value completes). */
function windowOf(inst: Instance): number[] { return (inst.state.w ??= []) as number[]; }
function pushWindow(inst: Instance, x: number, n: number): void {
  inst.pending = () => { const w = windowOf(inst); w.push(x); if (w.length > n - 1) w.splice(0, w.length - (n - 1)); };
}

const ohlcOf = (o: number, h: number, l: number, c: number): Value => { const r = plain(); r.open = o; r.high = h; r.low = l; r.close = c; return r; };
/** The candle a function of a bar reads: the object given when it holds prices, else the chart's candle. */
function candleArg(arg: Value, candle: Candle): Candle {
  if (isPlain(arg) && typeof arg.close === 'number') return { open: num(arg.open ?? arg.close), high: num(arg.high ?? arg.close), low: num(arg.low ?? arg.close), close: num(arg.close) };
  return candle;
}

export const BUILTINS: Readonly<Record<string, Builtin>> = {
  /** The running sum of every value so far. */
  cum(inst, [x]) {
    const v = num(x); if (!finite(v)) return NaN;
    const total = ((inst.state.total as number | undefined) ?? 0) + v;
    inst.pending = () => { inst.state.total = total; };
    return total;
  },
  /** The sum of the last `length` values (this candle's included; fewer while fewer exist). */
  sum(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst); let s = v; for (const y of w) s += y;
    pushWindow(inst, v, k); return s;
  },
  /** The average of the last `length` values (of those there are, while fewer exist). */
  sma(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst); let s = v; for (const y of w) s += y;
    pushWindow(inst, v, k); return s / (w.length + 1);
  },
  /** The cumulative average of every value so far. */
  cma(inst, [x]) {
    const v = num(x); if (!finite(v)) return NaN;
    const sum = ((inst.state.sum as number | undefined) ?? 0) + v, count = ((inst.state.count as number | undefined) ?? 0) + 1;
    inst.pending = () => { inst.state.sum = sum; inst.state.count = count; };
    return sum / count;
  },
  /** The exponential average: each value weighs 2 / (length + 1); the first value starts it. */
  ema(inst, [x, n]) { return smooth(inst, num(x), 2 / (len(n) + 1)); },
  /** The running (Wilder) average: each value weighs 1 / length. */
  rma(inst, [x, n]) { return smooth(inst, num(x), 1 / len(n)); },
  /** The highest of the last `length` values. */
  highest(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst); let m = v; for (const y of w) if (y > m) m = y;
    pushWindow(inst, v, k); return m;
  },
  /** The lowest of the last `length` values. */
  lowest(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst); let m = v; for (const y of w) if (y < m) m = y;
    pushWindow(inst, v, k); return m;
  },
  /** The least-squares line over the last `length` values, at this candle. */
  linreg(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const ys = [...windowOf(inst), v], m = ys.length;
    pushWindow(inst, v, k);
    if (m < 2) return v;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < m; i++) { sx += i; sy += ys[i]!; sxy += i * ys[i]!; sxx += i * i; }
    const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), icept = (sy - slope * sx) / m;
    return icept + slope * (m - 1);
  },
  /** The value `back` candles ago (1 by default): the instance remembers what it was given. */
  last(inst, [x, n]) {
    const v = num(x), k = len(n, 1);
    const w = windowOf(inst);
    const out = w.length >= k ? w[w.length - k]! : NaN;
    pushWindow(inst, v, k + 1);
    return out;
  },
  /** The stochastic: where the close stands between the lowest low and the highest high of the last `length` candles, 0 to 100. */
  stoch(inst, [close, high, low, n]) {
    const c = num(close), h = num(high), l = num(low), k = len(n);
    if (!finite(c) || !finite(h) || !finite(l)) return NaN;
    const hs = (inst.state.h ??= []) as number[], ls = (inst.state.l ??= []) as number[];
    let hh = h, ll = l;
    for (const y of hs) if (y > hh) hh = y;
    for (const y of ls) if (y < ll) ll = y;
    inst.pending = () => { hs.push(h); ls.push(l); if (hs.length > k - 1) { hs.splice(0, hs.length - (k - 1)); ls.splice(0, ls.length - (k - 1)); } };
    return hh === ll ? 50 : 100 * (c - ll) / (hh - ll);
  },
  /** A swing high: the value `right` candles ago when it is the highest of the `left` before it and the `right` after it, else NaN. */
  pivot_high(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), (a, b) => a > b); },
  /** A swing low, likewise. */
  pivot_low(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), (a, b) => a < b); },
  /** The average of the numbers given (arrays included), ignoring those that are not numbers. */
  avg(_inst, args) {
    let s = 0, c = 0;
    for (const a of args.flatMap(x => Array.isArray(x) ? x : [x])) { const v = num(a); if (finite(v)) { s += v; c++; } }
    return c ? s / c : NaN;
  },
  /** The chart's candle (`avg_ohlc(bar)`): open, high, low, close. */
  avg_ohlc(_inst, [b], _n, candle) { const c = candleArg(b, candle); return ohlcOf(c.open, c.high, c.low, c.close); },
  avg_ohlc_with_gaps(_inst, [b], _n, candle) { const c = candleArg(b, candle); return ohlcOf(c.open, c.high, c.low, c.close); },
  avg_close(_inst, [b], _n, candle) { return candleArg(b, candle).close; },
  /** Heikin-Ashi candles of the chart's: the close is the average of the four prices, the open the middle of the one before. */
  heikinashi(inst, [b], _n, candle) { return heikin(inst, candleArg(b, candle)); },
  avg_heikinashi(inst, [b], _n, candle) { return heikin(inst, candleArg(b, candle)); },
  /** A candle of a value: it opens where the last candle of it closed, and closes at the value. */
  ohlc(inst, [x]) {
    const v = num(x); if (!finite(v)) return ohlcOf(NaN, NaN, NaN, NaN);
    const open = (inst.state.close as number | undefined) ?? v;
    inst.pending = () => { inst.state.close = v; };
    return ohlcOf(open, Math.max(open, v), Math.min(open, v), v);
  },
  /** A candle of a running sum: it opens where the sum stood and closes with this value added (a CVD candle). */
  cum_ohlc(inst, [x]) {
    const v = num(x); if (!finite(v)) return ohlcOf(NaN, NaN, NaN, NaN);
    const open = (inst.state.total as number | undefined) ?? 0, close = open + v;
    inst.pending = () => { inst.state.total = close; };
    return ohlcOf(open, Math.max(open, close), Math.min(open, close), close);
  },
  /** The colour at `ratio` (0..1) along the colours given. */
  interpolate(_inst, [ratio, ...colors]) { return interpolateColors(num(ratio), colors.flatMap(c => Array.isArray(c) ? c : [c])); },
};

function smooth(inst: Instance, v: number, alpha: number): number {
  if (!finite(v)) return NaN;
  const prev = inst.state.prev as number | undefined;
  const next = prev === undefined ? v : prev + alpha * (v - prev);
  inst.pending = () => { inst.state.prev = next; };
  return next;
}

function pivot(inst: Instance, v: number, left: number, right: number, beats: (a: number, b: number) => boolean): number {
  const w = windowOf(inst), all = [...w, v];
  pushWindow(inst, finite(v) ? v : NaN, left + right + 1);
  if (all.length < left + right + 1) return NaN;
  const c = all.length - 1 - right, mid = all[c]!;
  if (!finite(mid)) return NaN;
  for (let k = c - left; k <= c + right; k++) if (k !== c && !beats(mid, all[k]!)) return NaN;
  return mid;
}

function heikin(inst: Instance, c: Candle): Value {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const prev = inst.state.prev as { open: number; close: number } | undefined;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  inst.pending = () => { inst.state.prev = { open, close }; };
  return ohlcOf(open, Math.max(c.high, open, close), Math.min(c.low, open, close), close);
}
