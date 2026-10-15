import type { MarketOrder } from './orders.ts';

/**
 * Every market order as it completes, for drawing only (the trade dust): never stored. The orders are the ones the recorders already rebuild
 * from fills (shared/orders.ts), so a venue that reports every fill and one that reports one row per taker order count alike, and the bubbles,
 * the size statistics and the dust agree on what one order is. A batch is columns: `inst` indexes `ids`; `usd` is signed (a buy positive, a
 * sell negative); `lo` and `hi` are the prices the order reached (equal to `price` for an order of one price). `seq` counts the source's
 * batches (a page that sees one missing knows the dust has a gap there); `dropped` is how many orders the batch left out (`TAPE_BATCH_MAX`).
 */
export interface TapeBatch { seq: number; dropped: number; ids: string[]; inst: Int32Array; t: Float64Array; price: Float64Array; usd: Float32Array; lo: Float64Array; hi: Float64Array }

/** How often a source sends what completed since the last batch. */
export const TAPE_BATCH_MS = 250;
/** The most orders one batch carries; past it the smallest of the batch are left out (a burst of tens of thousands a second is drawn by its largest). */
export const TAPE_BATCH_MAX = 20_000;

/** A batch of orders in completion order (the largest `max` when there are more). */
export function packTape(orders: readonly MarketOrder[], seq: number, max = TAPE_BATCH_MAX): TapeBatch {
  let list = orders;
  if (list.length > max) {
    const cut = Float64Array.from(list, o => o.usd).sort()[list.length - max]!;
    let ties = max - list.filter(o => o.usd > cut).length;
    list = list.filter(o => o.usd > cut || (o.usd === cut && ties-- > 0));
  }
  const index = new Map<string, number>(), ids: string[] = [], n = list.length;
  const out: TapeBatch = { seq, dropped: orders.length - n, ids, inst: new Int32Array(n), t: new Float64Array(n), price: new Float64Array(n), usd: new Float32Array(n), lo: new Float64Array(n), hi: new Float64Array(n) };
  list.forEach((o, i) => {
    let k = index.get(o.instrumentId); if (k === undefined) { k = ids.length; ids.push(o.instrumentId); index.set(o.instrumentId, k); }
    out.inst[i] = k; out.t[i] = o.t; out.price[i] = o.price; out.usd[i] = o.side === 'buy' ? o.usd : -o.usd; out.lo[i] = o.lo; out.hi[i] = o.hi;
  });
  return out;
}

/**
 * A batch checked at the boundary (a frame from the server or the worker): equal lengths, every id a string, every index inside `ids`.
 * Rows with a price, time or size that is not a finite positive number, or a span that does not hold the price, are dropped one by one.
 */
export function checkTape(raw: { seq?: unknown; dropped?: unknown; ids?: unknown; inst?: unknown; t?: unknown; price?: unknown; usd?: unknown; lo?: unknown; hi?: unknown }): TapeBatch | null {
  const { ids, inst, t, price, usd, lo, hi } = raw, seq = raw.seq, dropped = raw.dropped;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0) return null;
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || !(inst instanceof Int32Array) || !(t instanceof Float64Array)
    || !(price instanceof Float64Array) || !(usd instanceof Float32Array) || !(lo instanceof Float64Array) || !(hi instanceof Float64Array)) return null;
  const n = inst.length;
  if (t.length !== n || price.length !== n || usd.length !== n || lo.length !== n || hi.length !== n) return null;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = inst[i]!, p = price[i]!, a = lo[i]!, b = hi[i]!;
    if (k >= 0 && k < ids.length && Number.isFinite(t[i]!) && p > 0 && Number.isFinite(p) && usd[i] !== 0 && Number.isFinite(usd[i]!) && a > 0 && b >= a && p >= a * (1 - 1e-9) && p <= b * (1 + 1e-9)) keep.push(i);
  }
  if (keep.length === n) return { seq, dropped, ids: ids as string[], inst, t, price, usd, lo, hi };
  const pick = <A extends Int32Array | Float64Array | Float32Array>(src: A, make: (len: number) => A): A => { const out = make(keep.length); keep.forEach((j, i) => { out[i] = src[j]!; }); return out; };
  return { seq, dropped, ids: ids as string[], inst: pick(inst, len => new Int32Array(len)), t: pick(t, len => new Float64Array(len)), price: pick(price, len => new Float64Array(len)), usd: pick(usd, len => new Float32Array(len)), lo: pick(lo, len => new Float64Array(len)), hi: pick(hi, len => new Float64Array(len)) };
}
