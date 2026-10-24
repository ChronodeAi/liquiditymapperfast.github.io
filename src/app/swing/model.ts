/**
 * The Swing pane's two readings, per candle of the chart's timeframe:
 *
 * - **Swing**: two readings of where price sits in its recent range, 0 at the bottom and 100 at the top, and the bar between them. The slow
 *   line: where the close sits among the last `SWING_SLOW_LENGTH` closes, averaged over `SWING_SLOW_AVERAGE` candles. The fast line: where a
 *   Kalman estimate of the close (a steady gain of `SWING_FAST_GAIN`) sits among its last `SWING_FAST_LENGTH` values, smoothed by an EMA of
 *   `SWING_FAST_EMA`. The bar is coloured by the trend: a Kalman estimate (gain `SWING_GAIN`) of each candle's average of open, high, low
 *   and close higher than `SWING_TREND` candles before is up.
 * - **Cheap/hot**: 100 less where the close sits between the lowest low of the last `VALUE_LOW_LENGTH` candles and the highest high of the
 *   last `VALUE_HIGH_LENGTH`, averaged over `VALUE_SMOOTH` and smoothed by an EMA of `VALUE_EMA`: high when price has fallen to the bottom
 *   of its last month or so of candles (cheap), low when it has run to the top (hot). The top is judged over the shorter stretch, so a rally
 *   runs hot soon after an older, higher high falls out of it, while a low keeps counting for longer.
 *
 * Fitted to published charts' readings (Research_Findings.md): the Swing lines follow them to about 7 to 14 points in 100 and reach their
 * floor and ceiling zones in 54 of their 58 visits there; the cheap/hot reading follows them to under 1 point on average on every timeframe
 * from 1 hour to 1 day, and fifteen values the charts printed to 0.2 on average (0.8 at most). They say where price sits in its range, not
 * where it goes next.
 */
export const SWING_SLOW_LENGTH = 31, SWING_SLOW_AVERAGE = 8, SWING_FAST_LENGTH = 16, SWING_FAST_EMA = 4, SWING_FAST_GAIN = 0.0985;
export const SWING_GAIN = 0.1, SWING_TREND = 5;
/** Swing zones: a bar reaching under `SWING_LOW` is at the floor of the range, one reaching over `SWING_HIGH` at its ceiling. */
export const SWING_LOW = 15, SWING_HIGH = 92;
export const VALUE_HIGH_LENGTH = 22, VALUE_LOW_LENGTH = 33, VALUE_SMOOTH = 2, VALUE_EMA = 20;
/** Cheap/hot zones: from `VALUE_CHEAP` up is cheap, under `VALUE_HOT` hot. */
export const VALUE_CHEAP = 50, VALUE_HOT = 18.2;

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
  const n = candles.length, close = candles.map(c => c.c), average = candles.map(c => (c.o + c.h + c.l + c.c) / 4);
  const kalman = (values: readonly number[], gain: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < values.length; i++) out.push(i === 0 ? values[0]! : out[i - 1]! + gain * (values[i]! - out[i - 1]!));
    return out;
  };
  /** Where each value sits among the last `length` of them (null before there are that many). */
  const placed = (values: readonly number[], length: number): (number | null)[] => values.map((x, i) => {
    if (i < length - 1) return null;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - length + 1; j <= i; j++) { lo = Math.min(lo, values[j]!); hi = Math.max(hi, values[j]!); }
    return position(x, lo, hi);
  });
  const mean = (values: readonly (number | null)[], i: number, length: number): number | null => {
    if (i < length - 1) return null;
    let sum = 0; for (let j = i - length + 1; j <= i; j++) { const v = values[j]; if (v === null || v === undefined) return null; sum += v; }
    return sum / length;
  };
  const ema = (values: readonly (number | null)[], length: number): (number | null)[] => {
    const alpha = 2 / (length + 1); let acc: number | null = null;
    return values.map(v => v === null ? null : (acc = acc === null ? v : acc + alpha * (v - acc)));
  };
  const closePlaced = placed(close, SWING_SLOW_LENGTH);
  const slow = closePlaced.map((_, i) => mean(closePlaced, i, SWING_SLOW_AVERAGE));
  const fast = ema(placed(kalman(close, SWING_FAST_GAIN), SWING_FAST_LENGTH), SWING_FAST_EMA);
  const estimate = kalman(average, SWING_GAIN);
  // Cheap/hot: where the close sits between the lows' and the highs' extremes (each over its own stretch), turned over and smoothed.
  const k: (number | null)[] = new Array(n).fill(null);
  for (let i = Math.max(VALUE_HIGH_LENGTH, VALUE_LOW_LENGTH) - 1; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - VALUE_LOW_LENGTH + 1; j <= i; j++) lo = Math.min(lo, candles[j]!.l);
    for (let j = i - VALUE_HIGH_LENGTH + 1; j <= i; j++) hi = Math.max(hi, candles[j]!.h);
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
