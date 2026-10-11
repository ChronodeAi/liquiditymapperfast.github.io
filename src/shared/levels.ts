/** One side of a venue book in USD, with the price band each level represents. */
export interface SideLevels {
  /** Band lower edge, upper edge and USD notional per level (parallel arrays). */
  lo: Float64Array;
  hi: Float64Array;
  usd: Float64Array;
}
export interface ValuedBook {
  instrumentId: string;
  venue: string;
  /** Provider timestamp when known, otherwise receipt time. */
  timestamp: number;
  /** True when levels are aggregated provider bands rather than native ticks. */
  coarse: boolean;
  bids: SideLevels;
  asks: SideLevels;
}
/** A single venue's book crossed by more than this many basis points is a feed fault, not a market state. */
export const MAX_CROSSED_BP = 5;

/**
 * A trade at most this old says where a grouped book's touch is (`splitTouch`). Hyperliquid's book arrives every few seconds and a thin
 * coin's last trade is often older than ten (measured 2026-10-11): such a trade says where the price was, not where the touch is.
 */
export const TOUCH_HINT_MS = 10_000;

/**
 * A grouped book names a bid group by its lower edge and an ask group by its upper edge, so while the spread sits inside one group the top
 * bid group and the top ask group are the same price interval ([P, P + step) on Hyperliquid). Bids rest below the venue's price and asks
 * above it: the shared interval is split there, at `price` (the venue's last trade, when fresh and inside the interval) or else at the
 * interval's middle, so no reader sees bids above asks. The cut stays an eighth of the interval from either edge: a trade on the edge
 * would squeeze one side's whole group into a single price, a wall that is not there. Returns the sides unchanged when they do not overlap.
 */
export function splitTouch(bids: SideLevels, asks: SideLevels, price?: number): { bids: SideLevels; asks: SideLevels } {
  let bidTop = -Infinity, bidTopLo = Infinity, askBottom = Infinity, askBottomHi = -Infinity;
  for (let i = 0; i < bids.hi.length; i++) if (bids.hi[i]! > bidTop) { bidTop = bids.hi[i]!; bidTopLo = bids.lo[i]!; }
  for (let i = 0; i < asks.lo.length; i++) if (asks.lo[i]! < askBottom) { askBottom = asks.lo[i]!; askBottomHi = asks.hi[i]!; }
  // Only top groups that share an interval are split: a bid group wholly above the ask group is a crossed book, not a shared group, and
  // moving its liquidity would draw walls that are not there.
  const lo = Math.max(askBottom, bidTopLo), hi = Math.min(bidTop, askBottomHi);
  if (!(hi > lo)) return { bids, asks };
  const margin = (hi - lo) / 8;
  const cut = price !== undefined && price > lo && price < hi ? Math.min(hi - margin, Math.max(lo + margin, price)) : (lo + hi) / 2;
  const clip = (side: SideLevels, below: boolean): SideLevels => {
    const lo = Float64Array.from(side.lo), hi = Float64Array.from(side.hi);
    for (let i = 0; i < lo.length; i++) {
      if (below) { lo[i] = Math.min(lo[i]!, cut); hi[i] = Math.min(hi[i]!, cut); } else { lo[i] = Math.max(lo[i]!, cut); hi[i] = Math.max(hi[i]!, cut); }
    }
    return { lo, hi, usd: side.usd };
  };
  return { bids: clip(bids, true), asks: clip(asks, false) };
}

/**
 * How far the best bid sits above the best ask, in basis points (0 when the book is not crossed or a side is empty). It reads the extremes,
 * so the order a venue sends its levels in does not matter. Aggregated provider bands overlap at the touch by construction, so they are
 * not judged.
 */
export function crossedByBp(book: Pick<ValuedBook, 'bids' | 'asks' | 'coarse'>): number {
  if (book.coarse || !book.bids.usd.length || !book.asks.usd.length) return 0;
  let bid = -Infinity, ask = Infinity;
  for (const price of book.bids.hi) if (price > bid) bid = price;
  for (const price of book.asks.lo) if (price < ask) ask = price;
  return bid > ask ? (bid - ask) / ((bid + ask) / 2) * 1e4 : 0;
}
