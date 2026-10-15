import test from 'node:test';
import assert from 'node:assert/strict';
import { TAPE_BATCH_MAX, checkTape, packTape, type TapeBatch } from '../src/shared/tape.ts';
import type { MarketOrder } from '../src/shared/orders.ts';
import { BLOCK, STRIDE, TapeRing } from '../src/app/tape/ring.ts';
import { TraceIndex, secondsPath } from '../src/app/tape/trace.ts';
import { readBubbles } from '../src/app/prints.ts';

const T0 = 1_800_000_000_000;
const order = (id: string, t: number, price: number, usd: number, side: 'buy' | 'sell' = 'buy', lo = price, hi = price): MarketOrder => ({ instrumentId: id, tradeId: `${id}-${t}-${usd}`, side, t, price, lo, hi, usd, fills: 1 });
/** A batch of orders in one market, `n` of them a millisecond apart from `t`, at `price` + i. */
const batch = (seq: number, t: number, n: number, price = 80_000, id = 'binance:BTCUSDT'): TapeBatch => packTape(Array.from({ length: n }, (_, i) => order(id, t + i, price + i, 1_000 + i, i % 2 ? 'sell' : 'buy')), seq);

test('a batch carries every order as columns, a sell as negative USD, and the market ids once each', () => {
  const b = packTape([order('a:X', T0, 100, 5_000), order('b:Y', T0 + 1, 101, 7_000, 'sell', 100.5, 101.5), order('a:X', T0 + 2, 102, 9_000)], 4);
  assert.deepEqual(b.ids, ['a:X', 'b:Y']);
  assert.deepEqual([...b.inst], [0, 1, 0]);
  assert.deepEqual([...b.usd], [5_000, -7_000, 9_000]);
  assert.deepEqual([...b.lo], [100, 100.5, 102]); assert.deepEqual([...b.hi], [100, 101.5, 102]);
  assert.equal(b.seq, 4); assert.equal(b.dropped, 0);
});

test('past the batch limit the largest orders stay, ties to the earliest, and the batch says how many it left out', () => {
  const orders = [order('a:X', T0, 1, 10), order('a:X', T0 + 1, 1, 50), order('a:X', T0 + 2, 1, 30), order('a:X', T0 + 3, 1, 30), order('a:X', T0 + 4, 1, 20)];
  const b = packTape(orders, 0, 3);
  assert.deepEqual([...b.usd], [50, 30, 30]); assert.equal(b.dropped, 2);
  assert.ok(TAPE_BATCH_MAX >= 10_000);
});

test('a checked batch keeps good rows and drops bad ones; a malformed one is refused whole', () => {
  const b = packTape([order('a:X', T0, 100, 5_000), order('a:X', T0 + 1, 100, 6_000)], 1);
  assert.equal(checkTape(b)?.inst.length, 2);
  const bad = { ...b, price: Float64Array.from([100, Number.NaN]) };
  assert.deepEqual([...checkTape(bad)!.usd], [5_000]);
  const outside = { ...b, lo: Float64Array.from([101, 100]) };
  assert.equal(checkTape(outside)!.inst.length, 1, 'a span that does not hold the price is dropped');
  assert.equal(checkTape({ ...b, inst: Int32Array.from([0, 3]) })!.inst.length, 1, 'an index outside the ids is dropped');
  assert.equal(checkTape({ ...b, t: new Float64Array(1) }), null, 'columns of different lengths');
  assert.equal(checkTape({ ...b, ids: [1] }), null);
  assert.equal(checkTape({ ...b, seq: 1.5 }), null);
  assert.equal(checkTape({ ...b, usd: [1, 2] }), null, 'plain arrays are not taken for typed ones');
});

test('the ring keeps times and prices relative to its bases and gives them back exactly enough to draw', () => {
  const ring = new TapeRing(BLOCK * 2);
  ring.add(batch(0, T0, 3, 81_234.5), 1, 0);
  assert.equal(ring.size, 3); assert.equal(ring.t0, T0); assert.equal(ring.p0, 81_234.5);
  const r = ring.at(2);
  assert.equal(r.t, T0 + 2); assert.equal(r.price, 81_236.5); assert.equal(r.id, 'binance:BTCUSDT'); assert.equal(r.usd, 1_002);
  assert.equal(ring.data.length, BLOCK * 2 * STRIDE);
});

test('markets get one index across batches whatever order each batch names them in', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(packTape([order('a:X', T0, 1, 1), order('b:Y', T0, 1, 1)], 0), 1, 0);
  ring.add(packTape([order('b:Y', T0 + 1, 1, 1), order('c:Z', T0 + 1, 1, 1), order('a:X', T0 + 1, 1, 1)], 1), 1, 0);
  assert.deepEqual(ring.ids, ['a:X', 'b:Y', 'c:Z']);
  assert.deepEqual([2, 3, 4].map(k => ring.at(k).id), ['b:Y', 'c:Z', 'a:X']);
});

test('a full ring lets the oldest go, and says from when it holds everything', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(0, T0, BLOCK), 1, 0);
  assert.equal(ring.heldFrom, T0);
  ring.add(batch(1, T0 + 10_000, 10), 1, 0);
  assert.equal(ring.size, BLOCK); assert.equal(ring.first, 10);
  assert.equal(ring.heldFrom, T0 + 10, 'the oldest still held');
  assert.equal(ring.at(BLOCK + 9).t, T0 + 10_009);
});

test('a reconnect, a skipped batch or a trimmed one starts a new segment: the dust never hides a gap', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(5, T0, 2), 1, 0);
  ring.add(batch(6, T0 + 1_000, 2), 1, 0);
  assert.equal(ring.segments.length, 1); assert.equal(ring.segments[0]!.to, T0 + 1_001);
  ring.add(batch(8, T0 + 2_000, 2), 1, 0);
  assert.equal(ring.segments.length, 2, 'seq 7 never came');
  ring.add(batch(9, T0 + 3_000, 2), 2, 0);
  assert.equal(ring.segments.length, 3, 'a new connection');
  ring.add({ ...batch(10, T0 + 4_000, 2), dropped: 5 }, 2, 0);
  assert.equal(ring.segments.length, 4, 'a trimmed batch');
  assert.equal(ring.segments[3]!.from, T0 + 4_000);
});

test('the time base moves forward before offsets outgrow a float32, without moving any order', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(0, T0, 2), 1, 0);
  const epoch = ring.epoch, later = T0 + (1 << 24) + 5_000;
  ring.add(batch(1, later, 2), 1, 0);
  assert.ok(ring.epoch > epoch, 'the card copies it again whole');
  assert.equal(ring.t0, later);
  assert.equal(ring.at(0).t, T0); assert.equal(ring.at(3).t, later + 1);
});

test('runs find the orders of a window by blocks, oldest first, and skip blocks outside it', () => {
  const ring = new TapeRing(BLOCK * 4);
  ring.add(batch(0, T0, BLOCK), 1, 0);                  // block 0: T0 .. T0+4095
  ring.add(batch(1, T0 + 100_000, BLOCK), 1, 0);        // block 1
  ring.add(batch(2, T0 + 200_000, BLOCK), 1, 0);        // block 2
  assert.deepEqual(ring.runs(T0 + 100_000, T0 + 100_010), [[BLOCK, 2 * BLOCK]]);
  assert.deepEqual(ring.runs(T0, T0 + 300_000), [[0, 3 * BLOCK]], 'touching runs are joined');
  assert.deepEqual(ring.runs(T0 + 50_000, T0 + 60_000), []);
  ring.add(batch(3, T0 + 300_000, BLOCK + 5), 1, 0);    // wraps: block 0 now holds the newest five
  assert.deepEqual(ring.runs(T0 + 300_000 + BLOCK, T0 + 300_000 + BLOCK + 4), [[4 * BLOCK, 4 * BLOCK + 5]]);
  assert.deepEqual(ring.runs(T0, T0 + 10), [[5, BLOCK]], 'the oldest orders still held are found until they are overwritten');
});

test('the price line keeps each column\'s first, extremes and last price, by exchange time, whatever order they arrive in', () => {
  const ring = new TapeRing(BLOCK), trace = new TraceIndex();
  ring.add(packTape([order('a:X', T0 + 500, 100, 1), order('a:X', T0 + 100, 98, 1), order('a:X', T0 + 900, 99, 1, 'buy', 99, 103)], 0), 1, 0);
  trace.update(ring, T0, T0 + 10_000, 1_000);
  const runs = trace.path(0, Math.floor(T0 / 1_000), Math.floor(T0 / 1_000) + 9, 3), c = Math.floor(T0 / 1_000);
  // Open 98 (the earliest), close 99 (the latest): rising, so the low (98) comes before the high (103).
  assert.deepEqual(runs, [[c, 98, c, 98, c, 103, c, 99]]);
});

test('the price line breaks where a market traded nothing for the gap, and new orders are added without starting again', () => {
  const ring = new TapeRing(BLOCK), trace = new TraceIndex(), c = Math.floor(T0 / 1_000);
  ring.add(packTape([order('a:X', T0, 100, 1), order('a:X', T0 + 1_000, 101, 1), order('a:X', T0 + 6_000, 102, 1)], 0), 1, 0);
  trace.update(ring, T0, T0 + 20_000, 1_000);
  assert.equal(trace.path(0, c, c + 19, 3).length, 2, 'four empty columns break it');
  assert.equal(trace.path(0, c, c + 19, 5).length, 1);
  ring.add(packTape([order('a:X', T0 + 7_000, 103, 1)], 1), 1, 0);
  trace.update(ring, T0 + 50, T0 + 20_050, 1_000);
  assert.deepEqual(trace.path(0, c + 7, c + 7, 3), [[c + 7, 103, c + 7, 103]]);
});

test('the line from prices a second never carries a price over an empty second', () => {
  const prices = new Map([[10, 5], [11, 6], [15, 7]]), runs = secondsPath(s => prices.get(s) ?? 0, 10, 16, 1_000, 3);
  assert.deepEqual(runs, [[10, 5, 10, 5, 11, 6, 11, 6], [15, 7, 15, 7]]);
});

test('with the clock given, an order timed hours away from it is left out (one bad stamp must not move the time base every batch)', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(packTape([order('a:X', T0, 1, 1), order('a:X', 1_000, 1, 1), order('a:X', T0 + 7 * 3_600_000, 1, 1), order('a:X', T0 + 5, 1, 1)], 0), 1, 0, T0);
  assert.equal(ring.size, 2); assert.equal(ring.t0, T0); assert.deepEqual([ring.at(0).t, ring.at(1).t], [T0, T0 + 5]);
});

test('Live trades are on by default and read field by field from a saved page', () => {
  const d = readBubbles(undefined);
  assert.equal(d.live, true); assert.equal(d.venueLines, false); assert.equal(d.liveOpacity, 0.75);
  assert.deepEqual([readBubbles({ live: false }).live, readBubbles({ live: 'no' }).live], [false, true]);
  assert.equal(readBubbles({ liveOpacity: 5 }).liveOpacity, 1); assert.equal(readBubbles({ liveOpacity: 0.43 }).liveOpacity, 0.45);
  assert.equal(readBubbles({ venueLines: true }).venueLines, true);
});
