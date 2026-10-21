/**
 * The order-flow readings behind the volatile-move question (docs/volatility-watch.md): each is one of the ideas @karlbooklover posts about,
 * computed from what the local server records and phrased as a sentence a language model can read. Pure: the server gathers `VolatilityInputs`
 * (server/v2/volatility.mts), this turns them into numbers and words. Words are English on purpose (the reader is a model, not the page).
 */
import { anomalies } from '../anomaly.ts';
import type { FlowMinutesSeries } from '../flow.ts';

const MINUTE = 60_000;
/** How far back the inputs reach: a day of baseline plus the hour being judged. */
export const VOLATILITY_HISTORY_MS = 25 * 3_600_000;
const N = VOLATILITY_HISTORY_MS / MINUTE, DAY_MIN = 1_440;
/** A z-score needs at least this many earlier windows to stand against. */
const MIN_WINDOWS = 12;
/** A reading counts as a side only from this many standard deviations. */
const SIDE_Z = 1;
/** The highlight rule's parameters (the page's defaults). */
const HIGHLIGHT = { mult: 2, length: 72 };
/**
 * A move is under way when price has already travelled this many standard deviations of 15-minute returns within the last 15 minutes: the
 * distance the evaluation calls a volatile move, so a warning then would come during the move, not before it.
 */
export const MOVE_SIGMA = 2;

export interface VolatilityInputs {
  /** Whole minute (ms) the judged minute ends at. */
  now: number;
  coin: string;
  spot: FlowMinutesSeries[]; perp: FlowMinutesSeries[];
  binanceSpotId: string | null;
  /** Price and open-interest reference. */
  refPerpId: string | null;
  /**
   * Per minute over the last 6 h, summed over the coin's books: resting USD within 1 % of price and the Liquidity Tracker's weighted USD.
   * `books` names the books in the sum, in a fixed order; a minute is compared only with minutes of the same books, so a book dropping out
   * or coming back does not read as liquidity pulled or stacked.
   */
  depth: { t: number; books: string; bidUsd: number; askUsd: number; ltBid: number; ltAsk: number }[];
  /** Last 25 h. */
  liquidations: { t: number; side: 'long' | 'short'; usd: number }[];
  /** The reference perpetual's open interest, one-minute bars, last 2 h. */
  oi: { t: number; close: number }[];
  /** Per minute over the last 60 min, large market orders (the third size band, about $1M on BTC). */
  whale: { t: number; buyUsd: number; sellUsd: number }[];
  /**
   * Optional, for the image arm (server/v2/volatility-image.mts): resting USD summed over the coin's books, one column per minute over the last
   * `HEAT_MINUTES`, in `HEAT_ROWS` price rows of `HEAT_ROW_BP` around the judged minute's price (row 0 lowest), bids and asks apart, column-major.
   */
  heat?: { bid: Float64Array; ask: Float64Array; price: Float64Array };
}

export const HEAT_MINUTES = 120, HEAT_ROWS = 60, HEAT_ROW_BP = 5;
/** Minutes of raw history the long-context arm sends (`volatilitySeries`). */
export const SERIES_MINUTES = 1_440;

export type VolatilityValue = number | boolean | null;
export interface VolatilityFeatures {
  coin: string; t: number; price: number;
  values: Record<string, VolatilityValue>;
  /** One sentence per concept (the ids in `CONCEPT_IDS`); a concept with no data yet is absent. */
  words: Record<string, string>;
  /**
   * How far price has already travelled in the last 15 minutes (`sigma15`: the highest minus the lowest minute price over them, as a log
   * return, in standard deviations of the day's 15-minute returns) and whether that is a move under way (`MOVE_SIGMA` or more); null
   * without a day of returns. Not sent to the model: it keeps the page's warning to the quiet before a move.
   */
  move: { sigma15: number | null; underway: boolean | null };
}

export const CONCEPT_IDS = ['spotPerpDivergence', 'binanceSpotLeads', 'priceCvdDivergence', 'liquidityPulled', 'trackerFlip', 'bookImbalance', 'highlight', 'liquidationCascade', 'leverageBuild', 'whaleVsRetail', 'slicer'] as const;
export type ConceptId = typeof CONCEPT_IDS[number];

interface Group { delta: Float64Array; gross: Float64Array; /** Prefix sums of `delta`, length N + 1. */ cum: Float64Array; /** Index of the first minute with anything recorded (Infinity: none). */ first: number }

/** Minute sums over some instruments, on the grid of the N minutes ending at `now`. A minute no instrument recorded is 0. */
function groupOf(series: readonly FlowMinutesSeries[], now: number): Group {
  const delta = new Float64Array(N), gross = new Float64Array(N), origin = now - N * MINUTE;
  for (const s of series) {
    const offset = Math.round((s.t0 - origin) / MINUTE), n = Math.min(s.buy.length, s.sell.length);
    for (let k = 0; k < n; k++) {
      const i = offset + k; if (i < 0 || i >= N) continue;
      const b = s.buy[k]!, c = s.sell[k]!; delta[i]! += b - c; gross[i]! += b + c;
    }
  }
  const cum = new Float64Array(N + 1); let first = Infinity;
  for (let i = 0; i < N; i++) { cum[i + 1] = cum[i]! + delta[i]!; if (first === Infinity && gross[i]! > 0) first = i; }
  return { delta, gross, cum, first };
}
const windowSum = (g: Group, end: number, w: number): number => g.cum[end]! - g.cum[end - w]!;

/** Last price of each minute (carried forward, NaN before the first), from the first of `candidates` that traded; NaN throughout when the newest is over five minutes old. */
function priceOf(candidates: readonly FlowMinutesSeries[], now: number): Float64Array {
  const out = new Float64Array(N).fill(NaN), origin = now - N * MINUTE;
  for (const s of candidates) {
    const offset = Math.round((s.t0 - origin) / MINUTE), n = s.px.length;
    let any = false, last = NaN, lastAt = -1;
    const filled = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      const k = i - offset;
      if (k >= 0 && k < n && s.px[k]! > 0) { last = s.px[k]!; lastAt = i; any = true; }
      filled[i] = last;
    }
    if (!any) continue;
    if (lastAt < N - 5) continue;
    return filled;
  }
  return out;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
/**
 * The mean and standard deviation of `valueEnding` over the same-length, non-overlapping windows before the one ending now (a day's worth, none
 * starting before `firstActive`); null with fewer than `MIN_WINDOWS` of them or no spread.
 */
function dayStats(valueEnding: (end: number) => number, w: number, firstActive: number): { m: number; sd: number } | null {
  const xs: number[] = [];
  for (let j = 1; j <= Math.floor(DAY_MIN / w); j++) {
    const end = N - j * w, start = end - w;
    if (start < 0 || start < firstActive) break;
    const v = valueEnding(end); if (Number.isFinite(v)) xs.push(v);
  }
  if (xs.length < MIN_WINDOWS) return null;
  const m = mean(xs), sd = Math.sqrt(mean(xs.map(x => (x - m) * (x - m))));
  return sd > 0 ? { m, sd } : null;
}
/** `valueEnding` of the window ending now against `dayStats` of the windows before it. */
function zOf(valueEnding: (end: number) => number, w: number, firstActive: number): number | null {
  const current = valueEnding(N);
  if (!Number.isFinite(current)) return null;
  const day = dayStats(valueEnding, w, firstActive);
  return day ? (current - day.m) / day.sd : null;
}
const opposite = (a: number | null, b: number | null): boolean | null => a === null || b === null ? null : (a >= SIDE_Z && b <= -SIDE_Z) || (a <= -SIDE_Z && b >= SIDE_Z);

const round = (x: number, digits = 2): number => { const f = 10 ** digits; return Math.round(x * f) / f; };
const sigma = (z: number): string => `${z >= 0 ? '+' : '-'}${Math.abs(z).toFixed(1)}σ`;
const pct = (x: number, digits = 2): string => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(digits)} %`;
const usd = (x: number): string => {
  const a = Math.abs(x), s = x < 0 ? '-' : '';
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}K` : `${s}$${a.toFixed(0)}`;
};
const flowWord = (z: number): string => z >= SIDE_Z ? 'buying' : z <= -SIDE_Z ? 'selling' : 'quiet';

/** The newest entry of a time-sorted list at or before `at` and no older than `within` before it. */
function nearest<T extends { t: number }>(rows: readonly T[], at: number, within: number): T | null {
  let best: T | null = null;
  for (const row of rows) if (row.t <= at && row.t >= at - within && (!best || row.t > best.t)) best = row;
  return best;
}

export function volatilityFeatures(input: VolatilityInputs): VolatilityFeatures | null {
  const { now, coin } = input;
  if (!input.spot.length && !input.perp.length) return null;
  const spot = groupOf(input.spot, now), perp = groupOf(input.perp, now);
  const refPerp = input.perp.find(s => s.id === input.refPerpId);
  const price = priceOf([...(refPerp ? [refPerp] : []), ...input.perp, ...input.spot], now);
  const last = price[N - 1]!;
  if (!(last > 0)) return null;
  const firstActive = Math.min(spot.first, perp.first);

  const agg: Group = (() => {
    const delta = new Float64Array(N), gross = new Float64Array(N), cum = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) { delta[i] = spot.delta[i]! + perp.delta[i]!; gross[i] = spot.gross[i]! + perp.gross[i]!; cum[i + 1] = cum[i]! + delta[i]!; }
    return { delta, gross, cum, first: firstActive };
  })();
  const binanceSeries = input.binanceSpotId ? input.spot.find(s => s.id === input.binanceSpotId) : undefined;
  const binance = binanceSeries ? groupOf([binanceSeries], now) : null;

  const logReturn = (end: number, w: number): number => { const a = price[end - 1 - w]!, b = price[end - 1]!; return a > 0 && b > 0 ? Math.log(b / a) * 100 : NaN; };
  const ret15 = logReturn(N, 15), ret60 = logReturn(N, 60);
  const ret15Day = dayStats(end => logReturn(end, 15), 15, firstActive);
  const retZ15 = ret15Day && Number.isFinite(ret15) ? (ret15 - ret15Day.m) / ret15Day.sd : null;
  // How far price has already gone over the same 15 minutes (their 16 minute prices), against the day's 15-minute returns.
  const recent = Array.from(price.subarray(N - 16)).filter(p => p > 0);
  const moveSigma15 = ret15Day && recent.length >= 2 ? Math.log(Math.max(...recent) / Math.min(...recent)) * 100 / ret15Day.sd : null;
  const zOfGroup = (g: Group, w: number): number | null => zOf(end => windowSum(g, end, w), w, g.first);
  const spotZ15 = zOfGroup(spot, 15), perpZ15 = zOfGroup(perp, 15), spotZ60 = zOfGroup(spot, 60), perpZ60 = zOfGroup(perp, 60);
  const aggZ15 = zOfGroup(agg, 15);
  const binanceSpotZ60 = binance ? zOfGroup(binance, 60) : null;
  const finite = (x: number): number | null => Number.isFinite(x) ? x : null;

  // Depth, compared only with minutes that summed the same books as the latest one.
  const latest = nearest(input.depth, now, 2 * MINUTE);
  let bidChangePct: number | null = null, askChangePct: number | null = null;
  let ltNow: number | null = null, lt30: number | null = null, ltFlipped: boolean | null = null, imb1pct: number | null = null, imbPctile6h: number | null = null;
  if (latest) {
    const depth = input.depth.filter(d => d.books === latest.books);
    const before = depth.filter(d => d.t >= latest.t - 10 * MINUTE && d.t <= latest.t - 5 * MINUTE);
    if (before.length) {
      const b = mean(before.map(d => d.bidUsd)), a = mean(before.map(d => d.askUsd));
      if (b > 0) bidChangePct = (latest.bidUsd / b - 1) * 100;
      if (a > 0) askChangePct = (latest.askUsd / a - 1) * 100;
    }
    const lt = (d: { ltBid: number; ltAsk: number }): number | null => d.ltBid + d.ltAsk > 0 ? (d.ltBid - d.ltAsk) / (d.ltBid + d.ltAsk) : null;
    ltNow = lt(latest);
    const old = nearest(depth, latest.t - 30 * MINUTE, 3 * MINUTE);
    lt30 = old ? lt(old) : null;
    ltFlipped = ltNow !== null && lt30 !== null && ltNow !== 0 && lt30 !== 0 ? Math.sign(ltNow) !== Math.sign(lt30) : null;
    const imb = (d: { bidUsd: number; askUsd: number }): number | null => d.bidUsd + d.askUsd > 0 ? (d.bidUsd - d.askUsd) / (d.bidUsd + d.askUsd) : null;
    imb1pct = imb(latest);
    const all = depth.map(imb).filter((x): x is number => x !== null);
    if (imb1pct !== null && all.length >= 30) imbPctile6h = all.filter(x => x <= imb1pct!).length / all.length * 100;
  }

  // Highlight: the page's rule, on the last minute of aggregate volume and of absolute delta.
  const from = Math.max(0, Number.isFinite(firstActive) ? firstActive : N, N - 300);
  const sigmaOfLast = (series: Float64Array): number | null => {
    const tail = series.subarray(from); if (!tail.length) return null;
    return finite(anomalies(tail, HIGHLIGHT).sigma[tail.length - 1]!);
  };
  const volSigma = sigmaOfLast(agg.gross), deltaSigma = sigmaOfLast(agg.delta.map(Math.abs));

  // Liquidations.
  const liqSum = (side: 'long' | 'short' | null, end: number, w: number): number => {
    let s = 0; for (const l of input.liquidations) if (l.t >= end - w * MINUTE && l.t < end && (side === null || l.side === side)) s += l.usd; return s;
  };
  const liqLong5 = liqSum('long', now, 5), liqShort5 = liqSum('short', now, 5), liqLong15 = liqSum('long', now, 15), liqShort15 = liqSum('short', now, 15);
  const liqZ5 = zOf(end => liqSum(null, now - (N - end) * MINUTE, 5), 5, firstActive);

  // Open interest.
  const oiNow = nearest(input.oi, now, 5 * MINUTE);
  const oiChange = (minutes: number): number | null => {
    if (!oiNow) return null;
    const old = nearest(input.oi, oiNow.t - minutes * MINUTE, 5 * MINUTE);
    return old && old.close > 0 ? (oiNow.close / old.close - 1) * 100 : null;
  };
  const oi15Pct = oiChange(15), oi60Pct = oiChange(60);

  // Whales against everyone.
  // Only once an hour has been recorded: a shorter stretch would be called an hour.
  const hourRecorded = firstActive <= N - 60;
  const whaleNet60 = hourRecorded ? input.whale.filter(w => w.t >= now - 60 * MINUTE && w.t < now).reduce((s, w) => s + w.buyUsd - w.sellUsd, 0) : null;
  const aggDelta60 = windowSum(agg, N, 60);
  const whaleOpposite = whaleNet60 !== null && whaleNet60 !== 0 && aggDelta60 !== 0 ? Math.sign(whaleNet60) !== Math.sign(aggDelta60) : null;

  // A slicer: steady same-sign minutes on Binance spot.
  let slicerShare: number | null = null;
  if (binance && Number.isFinite(binance.first) && binance.first <= N - 30) {
    const d = Array.from(binance.delta.subarray(N - 30)).sort((a, b) => a - b);
    const median = (d[14]! + d[15]!) / 2;
    if (median !== 0) {
      let steady = 0;
      for (const x of binance.delta.subarray(N - 30)) { const r = x / median; if (r >= 0.5 && r <= 1.5) steady++; }
      slicerShare = steady / 30;
    }
  }

  const spotPerpOpposite = (() => { const a = opposite(spotZ15, perpZ15), b = opposite(spotZ60, perpZ60); return a === null && b === null ? null : a === true || b === true; })();
  const binanceLeads = binanceSpotZ60 === null || !Number.isFinite(ret60) ? null : Math.abs(binanceSpotZ60) >= SIDE_Z && ret60 !== 0 && Math.sign(binanceSpotZ60) !== Math.sign(ret60);
  const priceCvdOpposite = opposite(aggZ15, retZ15);

  const values: Record<string, VolatilityValue> = {
    ret15: finite(ret15) === null ? null : round(ret15, 3), ret60: finite(ret60) === null ? null : round(ret60, 3), retZ15,
    spotZ15, perpZ15, spotZ60, perpZ60, spotPerpOpposite,
    binanceSpotZ60, binanceLeads, aggZ15, priceCvdOpposite,
    bidChangePct, askChangePct, ltNow, lt30, ltFlipped, imb1pct, imbPctile6h,
    volSigma, deltaSigma,
    liqLong5: round(liqLong5, 0), liqShort5: round(liqShort5, 0), liqLong15: round(liqLong15, 0), liqShort15: round(liqShort15, 0), liqZ5,
    oi15Pct, oi60Pct, whaleNet60: whaleNet60 === null ? null : round(whaleNet60, 0), whaleOpposite, slicerShare,
  };
  for (const [k, v] of Object.entries(values)) if (typeof v === 'number') values[k] = round(v, Math.abs(v) >= 1000 ? 0 : 3);

  const words: Record<string, string> = {};
  const z = (x: number | null): x is number => x !== null;
  const spotPerp: string[] = [];
  if (z(spotZ15) && z(perpZ15)) spotPerp.push(`Spot taker flow over the last 15 minutes is ${sigma(spotZ15)} (${flowWord(spotZ15)}) while perpetual flow is ${sigma(perpZ15)} (${flowWord(perpZ15)}).`);
  if (z(spotZ60) && z(perpZ60)) spotPerp.push(`Over the last hour spot flow is ${sigma(spotZ60)} (${flowWord(spotZ60)}) and perpetual flow ${sigma(perpZ60)} (${flowWord(perpZ60)}).`);
  if (spotPerp.length) words.spotPerpDivergence = spotPerp.join(' ');
  if (z(binanceSpotZ60) && Number.isFinite(ret60)) words.binanceSpotLeads = `Binance spot taker flow over the last hour is ${sigma(binanceSpotZ60)} (${flowWord(binanceSpotZ60)}) while price moved ${pct(ret60)}.`;
  if (z(aggZ15) && z(retZ15) && Number.isFinite(ret15)) words.priceCvdDivergence = `Combined spot and perpetual taker flow over 15 minutes is ${sigma(aggZ15)} (${flowWord(aggZ15)}) while price moved ${pct(ret15)} (${sigma(retZ15)} against usual 15-minute moves).`;
  if (z(bidChangePct) && z(askChangePct)) words.liquidityPulled = `Resting liquidity within 1 % of price changed ${pct(bidChangePct, 0)} on the bid side and ${pct(askChangePct, 0)} on the ask side compared with 5 to 10 minutes earlier.`;
  if (z(ltNow) && z(lt30)) words.trackerFlip = `The Liquidity Tracker's bid-versus-ask imbalance near the touch is ${ltNow >= 0 ? '+' : '-'}${Math.abs(ltNow).toFixed(2)} now against ${lt30 >= 0 ? '+' : '-'}${Math.abs(lt30).toFixed(2)} 30 minutes ago${ltFlipped ? ' (it flipped sides)' : ''}; positive means more bids.`;
  if (z(imb1pct)) words.bookImbalance = `Within 1 % of price the aggregated book is ${imb1pct >= 0 ? 'bid' : 'ask'}-heavy by ${Math.abs(imb1pct * 100).toFixed(0)} % of its total${z(imbPctile6h) ? `, at the ${imbPctile6h.toFixed(0)}th percentile of the last 6 hours` : ''}.`;
  if (z(volSigma) || z(deltaSigma)) words.highlight = `Last minute: taker volume is ${z(volSigma) ? sigma(volSigma) : 'unknown'} and the size of net delta ${z(deltaSigma) ? sigma(deltaSigma) : 'unknown'} against the previous ${HIGHLIGHT.length} minutes (the chart highlights bars above +${HIGHLIGHT.mult}σ).`;
  words.liquidationCascade = `Liquidations: ${usd(liqLong5)} longs and ${usd(liqShort5)} shorts in the last 5 minutes (${usd(liqLong15)} and ${usd(liqShort15)} over 15)${z(liqZ5) ? `; the 5-minute total is ${sigma(liqZ5)} against the last day` : ''}.`;
  if (z(oi15Pct) || z(oi60Pct)) words.leverageBuild = `Open interest changed ${z(oi15Pct) ? pct(oi15Pct) : 'n/a'} over 15 minutes and ${z(oi60Pct) ? pct(oi60Pct) : 'n/a'} over the hour${Number.isFinite(ret60) ? ` while price moved ${pct(ret60)} over the hour` : ''}.`;
  if (z(whaleNet60)) words.whaleVsRetail = `Orders of about $1M and up were net ${whaleNet60 >= 0 ? 'buyers' : 'sellers'} by ${usd(Math.abs(whaleNet60))} over the last hour while all taker flow was net ${aggDelta60 >= 0 ? 'buying' : 'selling'} by ${usd(Math.abs(aggDelta60))}.`;
  if (z(slicerShare)) words.slicer = `${Math.round(slicerShare * 30)} of the last 30 minutes of Binance spot flow were steady, same-size, same-direction minutes (${(slicerShare * 100).toFixed(0)} %).`;

  return { coin, t: now, price: last, values, words, move: { sigma15: moveSigma15 === null ? null : round(moveSigma15), underway: moveSigma15 === null ? null : moveSigma15 >= MOVE_SIGMA } };
}

/**
 * The raw minute history behind the readings, as compact CSV for a long-context decision model: one row per minute over the last
 * `SERIES_MINUTES` (oldest first) with price, spot and perpetual net taker flow and gross volume ($K), resting USD within 1 % ($K, the last
 * 6 h only, and only minutes that summed the same books as the latest) and liquidations ($K). Empty fields are minutes with nothing
 * recorded. Null when there is no price.
 */
export function volatilitySeries(input: VolatilityInputs): string | null {
  const { now } = input;
  const spot = groupOf(input.spot, now), perp = groupOf(input.perp, now);
  const refPerp = input.perp.find(s => s.id === input.refPerpId);
  const price = priceOf([...(refPerp ? [refPerp] : []), ...input.perp, ...input.spot], now);
  if (!(price[N - 1]! > 0)) return null;
  const books = nearest(input.depth, now, 2 * MINUTE)?.books;
  const depth = new Map(input.depth.filter(d => d.books === books).map(d => [d.t, d]));
  const liq = new Map<number, { long: number; short: number }>();
  for (const l of input.liquidations) {
    const t = Math.floor(l.t / MINUTE) * MINUTE, row = liq.get(t) ?? { long: 0, short: 0 };
    row[l.side] += l.usd; liq.set(t, row);
  }
  const k = (x: number): string => x === 0 ? '0' : (x / 1e3).toFixed(0);
  const lines = ['utc,price,spot_net_k,perp_net_k,gross_k,bid1pct_k,ask1pct_k,liq_long_k,liq_short_k'];
  for (let i = N - SERIES_MINUTES; i < N; i++) {
    const t = now - (N - i) * MINUTE, p = price[i]!;
    const active = spot.gross[i]! + perp.gross[i]! > 0;
    const d = depth.get(t), l = liq.get(t);
    lines.push([
      new Date(t).toISOString().slice(11, 16), Number.isFinite(p) ? p.toFixed(1) : '',
      active ? k(spot.delta[i]!) : '', active ? k(perp.delta[i]!) : '', active ? k(spot.gross[i]! + perp.gross[i]!) : '',
      d ? k(d.bidUsd) : '', d ? k(d.askUsd) : '', l ? k(l.long) : '', l ? k(l.short) : '',
    ].join(','));
  }
  return lines.join('\n');
}
