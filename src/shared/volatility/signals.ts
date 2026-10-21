/**
 * Entry signals for the chart (docs/volatility-watch.md, "Signals on the chart"): the minutes the volatility watch's readings named a side,
 * kept as candidates so the page filters them by its own settings, each with what price did after it. Experimental: none of them has shown
 * an edge yet (Research_Findings.md); they are drawn to be looked at and measured.
 */
import type { AheadWarning } from './ahead.ts';
import type { Confluence } from './confluence.ts';
import { MOVE_SIGMA } from './features.ts';
import { WARN_MIN_CONFIDENCE } from './jev.ts';

export const SIGNAL_KINDS = ['jev', 'confluence'] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];

/** The lowest Jev score kept as a candidate; the page's own minimum (its Signals panel) filters further. */
export const SIGNAL_MIN_SCORE = 1.5;
const MINUTE = 60_000;

/**
 * What price did after a signal, in basis points signed by its side (positive: its way), from the minute prices: the return after 5, 15 and
 * 30 minutes, and the best and the worst within 15. Null until that minute is known.
 */
export interface SignalAfter { r5: number | null; r15: number | null; r30: number | null; best15: number | null; worst15: number | null }

export interface Signal {
  kind: SignalKind;
  /** The minute the readings were made for (its end, ms) and its last price. */
  t: number; price: number;
  side: 'long' | 'short';
  /**
   * Jev's assessment: its score (0 to 4), its confidence in the score, the probability it gave its side, and whether price was already
   * moving (`MOVE_SIGMA` over the 15 minutes before; null when unknown).
   */
  jev?: { score: number; confidence: number; p: number; underway: boolean | null };
  /** The confluence's call: its signed score (-1 to 1), the families with and against it, and what made the minute unusual. */
  confluence?: { score: number; agree: number; against: number; triggers: string[] };
  after: SignalAfter;
}

/**
 * What `/api/v2/signals` answers: the coin the watch reads, its signals in the window asked, oldest first, and the volatility-ahead warnings
 * that ended in it (`ahead.ts`), oldest first.
 */
export interface SignalAnswer { coin: string | null; signals: Signal[]; ahead: AheadWarning[] }

/** One minute of the volatility log (`server/v2/volatility.mts`), as far as signals read it. */
export interface SignalSource {
  features: { t: number; price: number; move?: { underway: boolean | null } };
  confluence?: Pick<Confluence, 'call' | 'direction' | 'score' | 'agree' | 'against' | 'triggers'>;
  verdict?: { score: number; scoreConfidence: number; direction: 'up' | 'down'; directionP: number; underway?: boolean | null };
}

/**
 * The signals of one minute, without their results: Jev's assessment from `SIGNAL_MIN_SCORE` with at least the page's confidence, and the
 * confluence's call. `underway` is the minute's own when it was logged (rows from before it existed have none: see `movedOf`).
 */
export function signalsOf(row: SignalSource): Omit<Signal, 'after'>[] {
  const { t, price } = row.features, out: Omit<Signal, 'after'>[] = [];
  if (!(price > 0)) return out;
  const v = row.verdict;
  if (v && v.score >= SIGNAL_MIN_SCORE && v.scoreConfidence >= WARN_MIN_CONFIDENCE) {
    const underway = typeof v.underway === 'boolean' ? v.underway : typeof row.features.move?.underway === 'boolean' ? row.features.move.underway : null;
    out.push({ kind: 'jev', t, price, side: v.direction === 'up' ? 'long' : 'short', jev: { score: v.score, confidence: v.scoreConfidence, p: v.directionP, underway } });
  }
  const c = row.confluence;
  if (c?.call && c.direction) out.push({ kind: 'confluence', t, price, side: c.direction === 'up' ? 'long' : 'short', confluence: { score: c.score, agree: c.agree, against: c.against, triggers: [...c.triggers] } });
  return out;
}

/** Basis points of a log return, signed by `sign`, to one decimal. */
const bp = (from: number, to: number, sign: number): number => Math.round(Math.log(to / from) * 1e5 * sign) / 10;

/** What price did after a signal, from the minute prices known so far (`priceAt`: a minute's last price by its end, undefined when not known). */
export function afterOf(signal: Pick<Signal, 't' | 'price' | 'side'>, priceAt: (t: number) => number | undefined): SignalAfter {
  const sign = signal.side === 'long' ? 1 : -1, p0 = signal.price;
  const at = (minutes: number): number | null => { const p = priceAt(signal.t + minutes * MINUTE); return p && p > 0 ? bp(p0, p, sign) : null; };
  let best: number | null = null, worst: number | null = null;
  // The extremes need the whole 15 minutes: a gap leaves them unknown rather than flattering.
  for (let m = 1; m <= 15; m++) {
    const x = at(m);
    if (x === null) { best = worst = null; break; }
    best = best === null ? x : Math.max(best, x); worst = worst === null ? x : Math.min(worst, x);
  }
  return { r5: at(5), r15: at(15), r30: at(30), best15: best, worst15: worst };
}

/**
 * Whether price was already moving at minute `t`, from the minute prices: the range of the 16 prices over the 15 minutes before against the
 * standard deviation of 15-minute log returns over the day before (at least 48 of them), at `MOVE_SIGMA`. The live watch measures the same on
 * its own price series (`VolatilityFeatures.move`); this fills in minutes logged before it did. Null without the prices.
 */
export function movedOf(t: number, priceAt: (t: number) => number | undefined): boolean | null {
  let high = -Infinity, low = Infinity;
  for (let m = 0; m <= 15; m++) { const p = priceAt(t - m * MINUTE); if (p && p > 0) { high = Math.max(high, p); low = Math.min(low, p); } }
  if (!(low > 0)) return null;
  let n = 0, sum = 0, squares = 0;
  for (let m = 0; m < 1_440; m++) {
    const end = t - m * MINUTE, a = priceAt(end - 15 * MINUTE), b = priceAt(end);
    if (!a || !b || !(a > 0) || !(b > 0)) continue;
    const r = Math.log(b / a); n++; sum += r; squares += r * r;
  }
  if (n < 48) return null;
  const mean = sum / n, sd = Math.sqrt(Math.max(0, squares / n - mean * mean));
  return sd > 0 ? Math.log(high / low) / sd >= MOVE_SIGMA : null;
}
