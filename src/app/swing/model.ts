/**
 * The Swing pane's two readings, per candle of the chart's timeframe:
 *
 * - **Swing**: where price sits in its last `SWING_LENGTH` candles, as a fast line (`SWING_FAST` candles' average) and a slow one (the fast
 *   line's `SWING_SLOW`-candle average), 0 at the bottom of the range and 100 at the top. Price is each candle's average of open, high, low and
 *   close (what a Heikin-Ashi chart calls its close), so a wick alone moves it a quarter as much. The bar between the two lines is coloured by
 *   the trend: a Kalman estimate of that price (a steady gain of `SWING_GAIN`) higher than `SWING_TREND` candles before is up.
 * - **Cheap/hot**: 100 less a slow stochastic of `VALUE_LENGTH` candles (close against their highest high and lowest low, averaged over
 *   `VALUE_SMOOTH`), smoothed by an EMA of `VALUE_EMA`: high when price has fallen to the bottom of its last month or so of candles (cheap),
 *   low when it has run to the top (hot).
 *
 * Fitted to a reference chart's readings (Research_Findings.md): the slow lines followed it to 8 to 10 points in 100, the cheap/hot reading
 * to under 1. They say where price sits in its range, not where it goes next.
 */
export const SWING_LENGTH = 29, SWING_FAST = 5, SWING_SLOW = 8, SWING_GAIN = 0.1, SWING_TREND = 5;
/** Swing zones: a bar reaching under `SWING_LOW` is at the floor of the range, one reaching over `SWING_HIGH` at its ceiling. */
export const SWING_LOW = 15, SWING_HIGH = 92;
export const VALUE_LENGTH = 34, VALUE_SMOOTH = 3, VALUE_EMA = 22;
/** Cheap/hot zones: from `VALUE_CHEAP` up is cheap, under `VALUE_HOT` hot. */
export const VALUE_CHEAP = 50, VALUE_HOT = 17.5;
/** Candles a reading needs before it is first drawn (the slowest chain's warm-up, with room for the EMA to settle). */
export const SWING_WARMUP = 120;

export interface SwingCandle { t: number; o: number; h: number; l: number; c: number }
export interface SwingRow {
  t: number;
  /** The fast and slow Swing lines, 0 to 100; null until enough candles came before. */
  fast: number | null; slow: number | null;
  /** The Kalman trend: up, down, or null until `SWING_TREND` candles came before. */
  up: boolean | null;
  /** The cheap/hot reading, 0 to 100 (high is cheap); null until enough candles came before. */
  value: number | null;
}
export type SwingZone = 'floor' | 'ceiling' | null;
export type ValueZone = 'cheap' | 'neutral' | 'hot';

/** Where `x` sits between the lowest and highest values of a window: 0 to 100, and 50 for a window with no range. */
const position = (x: number, lo: number, hi: number): number => hi > lo ? 100 * (x - lo) / (hi - lo) : 50;

/** Each candle's readings; a reading is null until the candles before it are enough to make it. */
export function swingRows(candles: readonly SwingCandle[]): SwingRow[] {
  const n = candles.length, price = candles.map(c => (c.o + c.h + c.l + c.c) / 4);
  const raw: (number | null)[] = new Array(n).fill(null), fast: (number | null)[] = new Array(n).fill(null), slow: (number | null)[] = new Array(n).fill(null);
  for (let i = SWING_LENGTH - 1; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - SWING_LENGTH + 1; j <= i; j++) { lo = Math.min(lo, price[j]!); hi = Math.max(hi, price[j]!); }
    raw[i] = position(price[i]!, lo, hi);
  }
  const mean = (values: readonly (number | null)[], i: number, length: number): number | null => {
    if (i < length - 1) return null;
    let sum = 0; for (let j = i - length + 1; j <= i; j++) { const v = values[j]; if (v === null || v === undefined) return null; sum += v; }
    return sum / length;
  };
  for (let i = 0; i < n; i++) fast[i] = mean(raw, i, SWING_FAST);
  for (let i = 0; i < n; i++) slow[i] = mean(fast, i, SWING_SLOW);
  const estimate: number[] = [];
  for (let i = 0; i < n; i++) estimate.push(i === 0 ? price[0]! : estimate[i - 1]! + SWING_GAIN * (price[i]! - estimate[i - 1]!));
  // Cheap/hot: a slow stochastic of the closes against the highs and lows, turned over and smoothed.
  const k: (number | null)[] = new Array(n).fill(null);
  for (let i = VALUE_LENGTH - 1; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - VALUE_LENGTH + 1; j <= i; j++) { lo = Math.min(lo, candles[j]!.l); hi = Math.max(hi, candles[j]!.h); }
    k[i] = position(candles[i]!.c, lo, hi);
  }
  const alpha = 2 / (VALUE_EMA + 1), value: (number | null)[] = new Array(n).fill(null);
  let smoothed: number | null = null;
  for (let i = 0; i < n; i++) {
    const slowK = mean(k, i, VALUE_SMOOTH); if (slowK === null) continue;
    const inverted = 100 - slowK;
    smoothed = smoothed === null ? inverted : smoothed + alpha * (inverted - smoothed);
    value[i] = smoothed;
  }
  return candles.map((c, i) => ({ t: c.t, fast: fast[i]!, slow: slow[i]!, up: i >= SWING_TREND ? estimate[i]! > estimate[i - SWING_TREND]! : null, value: value[i]! }));
}

/** The Swing zone a row's bar reaches into: the floor or the ceiling of the range (a bar reaching both, the floor). */
export function swingZone(row: SwingRow): SwingZone {
  if (row.fast === null || row.slow === null) return null;
  if (Math.min(row.fast, row.slow) <= SWING_LOW) return 'floor';
  if (Math.max(row.fast, row.slow) >= SWING_HIGH) return 'ceiling';
  return null;
}

export const valueZone = (value: number): ValueZone => value >= VALUE_CHEAP ? 'cheap' : value < VALUE_HOT ? 'hot' : 'neutral';
