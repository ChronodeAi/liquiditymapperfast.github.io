import { LT_LENGTH } from '../../shared/lt-sample.ts';
import type { ColumnSet } from '../wire.ts';

/**
 * One instrument's recorded columns as the raster worker holds them, flat for the raster kernel: column `c` starts at `times[c]` and has
 * `counts[c]` bins, its bins and amounts at the sum of the counts before it. `lt`: the tracker kept with the columns, LT_LENGTH floats a
 * column (NaN for a column that has none).
 */
export interface ColumnStore { step: number; times: Float64Array; counts: Uint32Array; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array }

export function toStore(set: ColumnSet): ColumnStore {
  return { step: set.step, times: Float64Array.from(set.times), counts: Uint32Array.from(set.counts), bins: set.bins, bid: set.bid, ask: set.ask, ...(set.lt ? { lt: set.lt } : {}) };
}

/**
 * `held` with every column from `from` on replaced by `set`'s, which are the columns of `from` onwards as the source has them now: the page's
 * refresh asks again only for the windows that could still change (`Hub.loadColumns`). The columns before `from` are kept as they are, so
 * `from` must be the start of a window. Without `held`, the store is `set`'s alone.
 */
export function withTail(held: ColumnStore | undefined, set: ColumnSet, from: number): ColumnStore {
  if (!held) return toStore(set);
  let keep = 0, keepBins = 0;
  while (keep < held.times.length && held.times[keep]! < from) keepBins += held.counts[keep++]!;
  const n = keep + set.times.length, nBins = keepBins + set.bins.length;
  const times = new Float64Array(n), counts = new Uint32Array(n);
  times.set(held.times.subarray(0, keep)); times.set(set.times, keep);
  counts.set(held.counts.subarray(0, keep)); counts.set(set.counts, keep);
  const join = <T extends Int32Array | Float32Array>(before: T, after: T, out: T): T => { out.set(before.subarray(0, keepBins) as never); out.set(after as never, keepBins); return out; };
  const store: ColumnStore = { step: set.step > 0 ? set.step : held.step, times, counts,
    bins: join(held.bins, set.bins, new Int32Array(nBins)), bid: join(held.bid, set.bid, new Float32Array(nBins)), ask: join(held.ask, set.ask, new Float32Array(nBins)) };
  // The trackers side by side as the source packs them: NaN where a column has none (one side may have none at all).
  if ((held.lt && keep > 0) || set.lt) {
    const lt = new Float32Array(n * LT_LENGTH).fill(NaN);
    if (held.lt) lt.set(held.lt.subarray(0, keep * LT_LENGTH));
    if (set.lt) lt.set(set.lt, keep * LT_LENGTH);
    store.lt = lt;
  }
  return store;
}
