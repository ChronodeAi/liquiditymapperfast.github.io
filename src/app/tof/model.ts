/**
 * Toxic flow (TOF), as the toxic-flow readings of the VPIN family show it: per venue and candle, how hard takers hit the market, taken as
 * the venue's taker volume weighted by how far price went in the candle (the square root of its high-to-low range over its open), judged
 * against the venue's own recent candles as a z score. Its bursts (z above 2) are what the volatility-ahead rings are made of; measured on
 * Binance BTCUSDT perpetual 5m bars, this reading's z follows the widely used toxic-flow reading's at a correlation of 0.98 and has a burst on
 * every bar that one does (Research_Findings.md, "One number for volatility ahead"). It says how hard, never which way: the candle's own
 * buys against sells come with it. Each candle also leaves its open as a level until a later candle trades through it.
 */

/** Candles a reading is judged against, and the fewest of them a z needs. */
export const TOF_WINDOW = 288, TOF_MIN_CANDLES = 50;
/** The bands of a z: a toxic burst above 2, elevated from 1, normal within 1 either side, quiet under −1. */
export const TOF_TOXIC = 2, TOF_ELEVATED = 1, TOF_QUIET = -1;
export type TofBand = 'toxic' | 'elevated' | 'normal' | 'quiet';

export function bandOf(z: number | null): TofBand | null {
  if (z === null || !Number.isFinite(z)) return null;
  return z > TOF_TOXIC ? 'toxic' : z >= TOF_ELEVATED ? 'elevated' : z >= TOF_QUIET ? 'normal' : 'quiet';
}

/** The candle fields the reading needs: start (ms), open, high, low. */
export interface TofCandle { t: number; o: number; h: number; l: number }

/** A venue's toxic flow in a candle: its taker volume (USD) times √((high − low) / open). Null without volume or a sound candle. */
export function tofOf(volume: number, c: TofCandle): number | null {
  if (!(volume > 0) || !(c.o > 0) || !(c.h >= c.l)) return null;
  return volume * Math.sqrt((c.h - c.l) / c.o);
}

/**
 * Each reading's z: of its logarithm against up to `TOF_WINDOW` positive readings before it (at least `TOF_MIN_CANDLES`), and `usual`, the
 * typical reading of those (their geometric mean). Null where the reading or its history is missing.
 */
export function tofScores(values: readonly (number | null)[]): { z: (number | null)[]; usual: (number | null)[] } {
  const n = values.length, logs = values.map(v => v !== null && v > 0 ? Math.log(v) : NaN);
  const z: (number | null)[] = new Array(n).fill(null), usual: (number | null)[] = new Array(n).fill(null);
  // Running sums over the window of logs before each candle.
  let s = 0, s2 = 0, c = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) { const x = logs[i - 1]!; if (Number.isFinite(x)) { s += x; s2 += x * x; c++; } }
    if (i > TOF_WINDOW) { const x = logs[i - 1 - TOF_WINDOW]!; if (Number.isFinite(x)) { s -= x; s2 -= x * x; c--; } }
    if (c < TOF_MIN_CANDLES) continue;
    const mean = s / c, sd = Math.sqrt(Math.max(0, s2 / c - mean * mean));
    usual[i] = Math.exp(mean);
    if (Number.isFinite(logs[i]!) && sd > 0) z[i] = (logs[i]! - mean) / sd;
  }
  return { z, usual };
}

/** A candle's open left as a level: its toxic flow over the venues and that reading's z, and the start of the candle that traded through it (null: untapped). */
export interface TofLevel { t: number; price: number; tof: number; z: number; taken: number | null }

/**
 * The levels the candles leave: each candle whose total reading has z at or above `minZ` leaves its open, taken by the first later candle whose
 * low to high contains it. Oldest first.
 */
export function tofLevels(candles: readonly TofCandle[], tof: readonly (number | null)[], z: readonly (number | null)[], minZ: number): TofLevel[] {
  const out: TofLevel[] = [];
  for (let i = 0; i < candles.length; i++) {
    const zi = z[i], v = tof[i];
    if (zi === null || zi === undefined || v === null || v === undefined || zi < minZ) continue;
    const c = candles[i]!;
    let taken: number | null = null;
    for (let j = i + 1; j < candles.length; j++) { const d = candles[j]!; if (d.l <= c.o && c.o <= d.h) { taken = d.t; break; } }
    out.push({ t: c.t, price: c.o, tof: v, z: zi, taken });
  }
  return out;
}

/** The untapped levels' toxic flow added up on price rows of `step` (a row's price is its lower edge), lowest first. */
export function tofByPrice(levels: readonly TofLevel[], step: number): { price: number; tof: number }[] {
  if (!(step > 0)) return [];
  const rows = new Map<number, number>();
  for (const l of levels) if (l.taken === null) { const row = Math.floor(l.price / step); rows.set(row, (rows.get(row) ?? 0) + l.tof); }
  return [...rows].sort((a, b) => a[0] - b[0]).map(([row, tof]) => ({ price: row * step, tof }));
}
