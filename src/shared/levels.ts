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

/** A trade at most this old says where a grouped book's touch is (`splitTouch`). */
export const TOUCH_HINT_MS = 60_000;

/**
 * A grouped book names a bid group by its lower edge and an ask group by its upper edge, so while the spread sits inside one group the top
 * bid group and the top ask group are the same price interval ([P, P + step) on Hyperliquid). Bids rest below the venue's price and asks
 * above it: the shared interval is split there, at `price` (the venue's last trade, when fresh) or without one at the interval's middle, so
 * no reader sees bids above asks. Returns the sides unchanged when they do not overlap.
 */
export function splitTouch(bids: SideLevels, asks: SideLevels, price?: number): { bids: SideLevels; asks: SideLevels } {
  let bidTop = -Infinity, askBottom = Infinity;
  for (const p of bids.hi) if (p > bidTop) bidTop = p;
  for (const p of asks.lo) if (p < askBottom) askBottom = p;
  if (!(bidTop > askBottom)) return { bids, asks };
  const cut = price !== undefined && Number.isFinite(price) ? Math.min(bidTop, Math.max(askBottom, price)) : (bidTop + askBottom) / 2;
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
