/**
 * A directional reading of the volatility features without a model (docs/volatility-watch.md, "Confluence"). The readings are grouped into three
 * families of independent data, each casts one vote in [-1, 1], and a call is made only when families agree, none disagrees and something
 * unusual is happening now. Readings inside a family move together, so they never count twice. Pure, and a function of the logged values
 * alone, so `scripts/volatility-eval.mts` scores rows written before it existed.
 */
import type { VolatilityValue } from './features.ts';

export const FAMILY_IDS = ['flow', 'book', 'positioning'] as const;
export type FamilyId = typeof FAMILY_IDS[number];

export interface Confluence {
  /** Mean of the family votes, -1 (every family says down at full strength) to +1. Families without data count as 0. */
  score: number;
  /** The side the votes add up to; null when they cancel or nothing voted. */
  direction: 'up' | 'down' | null;
  /** Families voting with `direction`, and against it. */
  agree: number; against: number;
  /** Each family's vote; null when it had no reading. */
  votes: Record<FamilyId, number | null>;
  /** What makes this minute unusual (empty: nothing, so no call). */
  triggers: string[];
  /** At least `MIN_AGREE` families agree, none disagrees and a trigger is on. */
  call: boolean;
}

/** One minute's confluence as the watch keeps it: the minute (ms), the coin and its price then. */
export interface ConfluenceReading extends Confluence { t: number; coin: string; price: number }

/** A flow z-score counts as a side from here, and at full strength from `FULL_Z`. */
const SIDE_Z = 1, FULL_Z = 3;
/** A vote smaller than this is no vote. */
const VOTE_MIN = 0.25;
/** One side's resting liquidity within 1 % fell at least this much (%) in 5 to 10 minutes while the other side held. */
const PULL_PCT = 30, HOLD_PCT = -10;
/** The book's imbalance is unusual at these percentiles of the last 6 h. */
const IMB_HIGH = 90, IMB_LOW = 10;
/** The page's Highlights rule and a liquidation burst, in standard deviations. */
const UNUSUAL_SIGMA = 2;
/** Open interest built this much (%) in 15 minutes into a move. */
const OI_BUILD_PCT = 0.3;
export const MIN_AGREE = 2;

const num = (v: VolatilityValue | undefined): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
const strength = (z: number): number => Math.sign(z) * Math.min(Math.abs(z) / FULL_Z, 1);
/** Sum of the parts, clamped; null when no part had a reading. */
const family = (parts: (number | null)[]): number | null => { const present = parts.filter((p): p is number => p !== null); return present.length ? clamp(present.reduce((a, b) => a + b, 0)) : null; };

/**
 * Taker flow. Spot leads (@karlbooklover: "you want exposure to whatever the spot cvd is currently biased towards"): the spot 15-minute z,
 * else the hour's; without a spot side, Binance spot over the hour at three quarters. Large orders trading against everyone add half a vote
 * their way, a steady Binance spot slicer a quarter.
 */
function flowVote(v: Record<string, VolatilityValue>): number | null {
  const spotZ = num(v.spotZ15) ?? num(v.spotZ60), binanceZ = num(v.binanceSpotZ60);
  let lead: number | null = null;
  if (spotZ !== null) lead = Math.abs(spotZ) >= SIDE_Z ? strength(spotZ) : 0;
  if ((lead === null || lead === 0) && binanceZ !== null) lead = Math.abs(binanceZ) >= SIDE_Z ? 0.75 * strength(binanceZ) : (lead ?? 0);
  const whaleNet = num(v.whaleNet60);
  const whale = v.whaleOpposite === true && whaleNet !== null && whaleNet !== 0 ? 0.5 * Math.sign(whaleNet) : v.whaleOpposite === false ? 0 : null;
  const slicerShare = num(v.slicerShare);
  const slicer = slicerShare !== null && binanceZ !== null ? (slicerShare >= 0.6 && binanceZ !== 0 ? 0.25 * Math.sign(binanceZ) : 0) : null;
  return family([lead, whale, slicer]);
}

/**
 * Resting liquidity. A side pulled while the other holds leaves no cushion that way (market makers stop replenishing bids: price falls
 * through); the tracker flipping votes for the side it flipped to; an imbalance at the edge of the last 6 h votes with the heavy side.
 */
function bookVote(v: Record<string, VolatilityValue>): number | null {
  const bid = num(v.bidChangePct), ask = num(v.askChangePct);
  const pulled = bid === null || ask === null ? null : bid <= -PULL_PCT && ask >= HOLD_PCT ? -0.5 : ask <= -PULL_PCT && bid >= HOLD_PCT ? 0.5 : 0;
  const ltNow = num(v.ltNow);
  const flip = v.ltFlipped === true && ltNow !== null && ltNow !== 0 ? 0.5 * Math.sign(ltNow) : v.ltFlipped === false ? 0 : null;
  const pctile = num(v.imbPctile6h), imb = num(v.imb1pct);
  const edge = pctile === null || imb === null ? null : pctile >= IMB_HIGH && imb > 0 ? 0.5 : pctile <= IMB_LOW && imb < 0 ? -0.5 : 0;
  return family([pulled, flip, edge]);
}

/**
 * Forced and crowded positions, read against the move: a liquidation burst that is mostly longs marks forced sellers at a pivot (votes up),
 * mostly shorts the reverse; open interest building into a 15-minute move is fuel for the next forced wave the other way.
 */
function positioningVote(v: Record<string, VolatilityValue>): number | null {
  const liqZ = num(v.liqZ5), longs = num(v.liqLong5), shorts = num(v.liqShort5);
  const liq = liqZ === null || longs === null || shorts === null ? null
    : liqZ >= UNUSUAL_SIGMA && longs > 2 * shorts ? 0.5 : liqZ >= UNUSUAL_SIGMA && shorts > 2 * longs ? -0.5 : 0;
  const oi = num(v.oi15Pct), ret = num(v.ret15);
  const build = oi === null || ret === null ? null : oi >= OI_BUILD_PCT && ret !== 0 ? -0.5 * Math.sign(ret) : 0;
  return family([liq, build]);
}

/** What makes the minute unusual: a highlighted bar, a liquidation burst, or flow disagreeing with itself or with price. */
function triggersOf(v: Record<string, VolatilityValue>): string[] {
  const out: string[] = [];
  const vol = num(v.volSigma), delta = num(v.deltaSigma), liq = num(v.liqZ5);
  if ((vol !== null && vol >= UNUSUAL_SIGMA) || (delta !== null && delta >= UNUSUAL_SIGMA)) out.push('highlight');
  if (liq !== null && liq >= UNUSUAL_SIGMA) out.push('liquidations');
  if (v.spotPerpOpposite === true) out.push('spotPerpDivergence');
  if (v.priceCvdOpposite === true) out.push('priceCvdDivergence');
  return out;
}

export function confluence(values: Record<string, VolatilityValue>): Confluence {
  const votes: Record<FamilyId, number | null> = { flow: flowVote(values), book: bookVote(values), positioning: positioningVote(values) };
  const cast = FAMILY_IDS.map(id => votes[id]).filter((x): x is number => x !== null && Math.abs(x) >= VOTE_MIN);
  const sum = FAMILY_IDS.reduce((s, id) => s + (votes[id] ?? 0), 0);
  const direction = sum > 0 && cast.length ? 'up' : sum < 0 && cast.length ? 'down' : null;
  const sign = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
  const agree = sign ? cast.filter(x => Math.sign(x) === sign).length : 0;
  const against = sign ? cast.filter(x => Math.sign(x) === -sign).length : 0;
  const triggers = triggersOf(values);
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    score: round(sum / FAMILY_IDS.length), direction, agree, against,
    votes: { flow: votes.flow === null ? null : round(votes.flow), book: votes.book === null ? null : round(votes.book), positioning: votes.positioning === null ? null : round(votes.positioning) },
    triggers, call: agree >= MIN_AGREE && against === 0 && triggers.length > 0,
  };
}
