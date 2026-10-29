/**
 * Volatility ahead (docs/volatility-watch.md, "Volatility ahead"): a 5m, 15m or 1h bar that traded far more than usual while price had hardly
 * moved. On Binance's BTCUSDT perpetual from 2024-01 to 2026-10 (Research_Findings.md, "One number for volatility ahead"), a move of 2σ came
 * within the next 6 bars after 55 % of them at 5m, 67 % at 15m and 61 % at 1h, against 22 to 26 % of the other quiet bars. The bar's buying
 * or selling did not say which way (its side matched the move's 50 % of the time at 5m), and the size of that imbalance added nothing to
 * the volume.
 */

const MINUTE = 60_000;
/** Minutes per bar. */
export const AHEAD_TFS = [5, 15, 60] as const;
export type AheadTf = typeof AHEAD_TFS[number];

/**
 * A bar's volume is measured against up to `window` bars before it (at least `minBars` with volume) as the z of its logarithm. At `z` or
 * more, with none of the 3 bars before at it, it starts a run of high volume, and it warns when price is quiet then: the last 3 bars moved
 * less than `quiet` σ, σ being the standard deviation of 3-bar returns over the same bars. The move looked for is `move` σ within `bars` bars.
 */
export const AHEAD = { window: 288, minBars: 120, z: 2, quiet: 1, move: 2, bars: 6 } as const;

export interface AheadAfter {
  /** The side whose `AHEAD.move` σ price reached first within the bars ahead, and the end of the minute it did; null while it has not. */
  moved: 'up' | 'down' | null; at: number | null;
  /** The furthest price went each way so far, in basis points from the close (up from 0, down to 0); null before a minute after it is known. */
  up: number | null; down: number | null;
  /** The bars ahead are over, or the move came: nothing more changes. */
  done: boolean;
}

export interface AheadWarning {
  tf: AheadTf;
  /** The end of the bar (ms): the warning is known then. */
  t: number;
  /** The bar's close. */
  price: number;
  /** Its volume against the bars before: the z of its logarithm, and the multiple of their typical (geometric mean) volume. */
  z: number; times: number;
  /** σ as a fraction of price: the standard deviation of 3-bar returns over the bars before. */
  sigma: number;
  after: AheadAfter;
}

/** One instrument's minutes from `t0` (FlowMinutesSeries): USD bought and sold at market, and the last price (0: none recorded). */
export interface AheadMinutes { t0: number; buy: ArrayLike<number>; sell: ArrayLike<number>; px: ArrayLike<number> }

/** Mean and standard deviation of the finite values of `value(j)` for the up to `AHEAD.window` bars before `k`, or null with fewer than `AHEAD.minBars`. */
function before(k: number, value: (j: number) => number): { mean: number; sd: number } | null {
  let s = 0, s2 = 0, c = 0;
  for (let j = Math.max(0, k - AHEAD.window); j < k; j++) { const x = value(j); if (Number.isFinite(x)) { s += x; s2 += x * x; c++; } }
  if (c < AHEAD.minBars) return null;
  const mean = s / c;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / c - mean * mean)) };
}

const bp = (price: number, from: number): number => Math.round((price / from - 1) * 1e5) / 10;

/**
 * The warnings at `tf` in the minutes, for bars that ended by `now` (bars on UTC multiples of `tf`; a bar with a minute without a price is
 * left out), oldest first, each with what price did in the minutes after it up to `now`. From minute prices: a move within a minute that did
 * not last to its end is not seen.
 */
export function aheadWarnings(m: AheadMinutes, tf: AheadTf, now: number): AheadWarning[] {
  const tfMs = tf * MINUTE, end = Math.min(now, m.t0 + m.px.length * MINUTE);
  const first = Math.ceil(m.t0 / tfMs) * tfMs, n = Math.max(0, Math.floor((end - first) / tfMs));
  const lnVol = new Float64Array(n).fill(NaN), close = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const i0 = (first + k * tfMs - m.t0) / MINUTE;
    let volume = 0, whole = true;
    for (let i = i0; i < i0 + tf; i++) { if (!(m.px[i]! > 0)) { whole = false; break; } volume += m.buy[i]! + m.sell[i]!; }
    if (!whole) continue;
    close[k] = m.px[i0 + tf - 1]!;
    if (volume > 0) lnVol[k] = Math.log(volume);
  }
  const r3 = (k: number): number => k >= 3 ? close[k]! / close[k - 3]! - 1 : NaN;
  const z = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(lnVol[k]!)) continue;
    const v = before(k, j => lnVol[j]!);
    if (v && v.sd > 0) z[k] = (lnVol[k]! - v.mean) / v.sd;
  }
  const out: AheadWarning[] = [];
  for (let k = 3; k < n; k++) {
    if (!(z[k]! >= AHEAD.z) || z[k - 1]! >= AHEAD.z || z[k - 2]! >= AHEAD.z || z[k - 3]! >= AHEAD.z) continue;
    const s = before(k, r3), moved3 = r3(k);
    if (!s || !(s.sd > 0) || !(Math.abs(moved3) < AHEAD.quiet * s.sd)) continue;
    const t = first + (k + 1) * tfMs, price = close[k]!, sigma = s.sd, until = t + AHEAD.bars * tfMs;
    const v = before(k, j => lnVol[j]!)!;
    const after: AheadAfter = { moved: null, at: null, up: null, down: null, done: false };
    const upAt = price * (1 + AHEAD.move * sigma), downAt = price * (1 - AHEAD.move * sigma);
    for (let i = (t - m.t0) / MINUTE; i < (Math.min(until, end) - m.t0) / MINUTE; i++) {
      const p = m.px[i]!; if (!(p > 0)) continue;
      after.up = Math.max(after.up ?? 0, bp(p, price)); after.down = Math.min(after.down ?? 0, bp(p, price));
      if (p >= upAt || p <= downAt) { after.moved = p >= upAt ? 'up' : 'down'; after.at = m.t0 + (i + 1) * MINUTE; break; }
    }
    after.done = after.moved !== null || end >= until;
    out.push({ tf, t, price, z: Math.round(z[k]! * 100) / 100, times: Math.round(Math.exp(lnVol[k]! - v.mean) * 10) / 10, sigma, after });
  }
  return out;
}
