/**
 * The Liquidity Tracker as the recorder keeps it: every venue's book, at every sample, measured from that venue's own best bid and best
 * ask, for each half-life the pane offers. Venues do not trade at one price (USDT spot sits several bp
 * above the perpetuals, USD spot below them), so a level is near the touch when it is near its own venue's touch; measured from one price
 * shared by every venue, the weights followed the venues' premiums instead of the liquidity (measured 2026-10-11: 6.7 points of imbalance
 * apart at a 10 bp half-life, the other side in a quarter of the minutes).
 *
 * It is taken from each sample's book, before the minute is averaged: a minute's average book is smeared by the price moving inside it,
 * and its best bid is the highest of the minute, which put a moving minute's bids 13 % short (6 points of imbalance). Kept as means over
 * the samples of a minute, each venue apart; windows of minutes average them by their samples, and venues add up.
 */

/** The half-lives the pane offers, in basis points: the tracker is kept for each. */
export const LT_HALF_LIVES = [2, 5, 10, 25, 50, 100, 250, 1000] as const;
/** Per half-life: bid USD x weight, ask USD x weight, the bid weights, the ask weights (over the bins holding something). */
export const LT_FIELDS = 4;
export const LT_LENGTH = LT_HALF_LIVES.length * LT_FIELDS;

/** Weight of a level `bp` basis points from its side's touch: 1 at the touch, 1/2 every half-life. */
export function ltWeight(bp: number, halfLifeBp: number): number { return Math.pow(2, -Math.max(0, bp) / Math.max(halfLifeBp, 1e-9)); }

/**
 * Add one venue's book at one instant to `into` (length LT_LENGTH): its bins (bin -> USD; a bin's price is its middle, (bin + 0.5) x step),
 * measured from its own best bid and best ask. A side with nothing adds nothing.
 */
export function addLtSample(bid: ReadonlyMap<number, number>, ask: ReadonlyMap<number, number>, step: number, into: Float64Array): void {
  let bestBid = -Infinity, bestAsk = Infinity;
  for (const [bin, usd] of bid) if (usd > 0 && bin > bestBid) bestBid = bin;
  for (const [bin, usd] of ask) if (usd > 0 && bin < bestAsk) bestAsk = bin;
  const side = (map: ReadonlyMap<number, number>, touchBin: number, isBid: boolean): void => {
    if (!Number.isFinite(touchBin)) return;
    const touch = (touchBin + 0.5) * step, at = isBid ? 0 : 1;
    for (const [bin, usd] of map) {
      if (!(usd > 0)) continue;
      const price = (bin + 0.5) * step, bp = Math.max(0, (isBid ? touch - price : price - touch) / touch * 1e4);
      // A level forty half-lives away weighs under 2^-40 (nothing): most of a deep book is that far for the short half-lives, so the
      // longest are worked out first and the loop stops at the first that weighs nothing.
      for (let h = LT_HALF_LIVES.length - 1; h >= 0; h--) {
        const half = LT_HALF_LIVES[h]!;
        if (bp > 40 * half) break;
        const w = Math.pow(2, -bp / half);
        into[h * LT_FIELDS + at] += usd * w; into[h * LT_FIELDS + 2 + at] += w;
      }
    }
  };
  side(bid, bestBid, true); side(ask, bestAsk, false);
}

/** Where a half-life's fields start in a kept tracker (-1 when the pane asks for one that is not kept). */
export const ltIndex = (halfLifeBp: number): number => { const h = (LT_HALF_LIVES as readonly number[]).indexOf(halfLifeBp); return h < 0 ? -1 : h * LT_FIELDS; };
