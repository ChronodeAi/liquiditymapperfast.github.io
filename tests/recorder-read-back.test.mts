import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthRecorder, COLUMN_MS, SAMPLE_MS, type Column, type ColumnStore } from '../src/server/v2/recorder.mts';
import type { ValuedBook, SideLevels } from '../src/server/v2/levels.mts';
import { FootprintRecorder, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';

/**
 * A server reads back what it does not hold in memory (`memoryMs`): the depth columns and the footprint rows older than that come from its
 * store when a question reaches them. These tests hold a recorder that keeps everything in memory beside one that reads back, over the same
 * store, and check that every answer is the same; and that what is written into a minute only the store holds keeps all of that minute.
 */

const MIN = COLUMN_MS, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Math.floor(Date.UTC(2026, 9, 1, 0, 0) / DAY) * DAY;

let seed = 7;
const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };

/** A column store in memory that reads back, and counts how often it was asked. */
class MemoryColumnStore implements ColumnStore {
  readonly rows = new Map<string, { id: string; column: Column; step: number }>();
  reads = 0; rowsRead = 0; failing = false;
  load(since: number) { return [...this.rows.values()].filter(r => r.column.t >= since).sort((a, b) => a.id.localeCompare(b.id) || a.column.t - b.column.t).map(r => ({ instrumentId: r.id, column: r.column, step: r.step })); }
  save(id: string, column: Column, step: number): void { if (this.failing) throw new Error('disk full'); this.rows.set(`${id}|${column.t}`, { id, column, step }); }
  prune(before: number): void { for (const [key, r] of this.rows) if (r.column.t < before) this.rows.delete(key); }
  range(id: string, from: number, to: number): Column[] {
    this.reads++;
    const out = [...this.rows.values()].filter(r => r.id === id && r.column.t >= from && r.column.t < to).map(r => r.column).sort((a, b) => a.t - b.t);
    this.rowsRead += out.length; return out;
  }
  extent(since: number) {
    const out = new Map<string, { first: number; last: number; step: number }>();
    for (const r of [...this.rows.values()].sort((a, b) => a.column.t - b.column.t)) {
      if (r.column.t < since) continue;
      const e = out.get(r.id); if (e) e.last = r.column.t; else out.set(r.id, { first: r.column.t, last: r.column.t, step: r.step });
    }
    return out;
  }
}
/** The same store without reading back: what the browser's is. */
const holdingOnly = (store: MemoryColumnStore): ColumnStore => ({ load: s => store.load(s), save: (i, c, s) => store.save(i, c, s), prune: b => store.prune(b) });

const columnAt = (t: number, base: number): Column => {
  // Bins ascending and distinct, as the recorder writes them.
  const count = 3 + Math.floor(rnd() * 40), bins = new Int32Array(count), bid = new Float32Array(count), ask = new Float32Array(count);
  for (let i = 0, bin = base + Math.floor(rnd() * 10); i < count; i++, bin += 1 + Math.floor(rnd() * 3)) { bins[i] = bin; bid[i] = Math.round(rnd() * 5e5); ask[i] = Math.round(rnd() * 5e5); }
  const column: Column = { t, n: 1 + Math.floor(rnd() * 12), bins, bid, ask };
  if (rnd() < 0.7) { column.lt = Float32Array.from({ length: LT_LENGTH }, () => Math.round(rnd() * 1e6)); column.ltN = column.n; }
  return column;
};

test('reading depth back gives every answer that holding the week gave, across the edge of what memory holds, and asks the store once', () => {
  seed = 7;
  const NOW = T0 + 3 * DAY + 17 * MIN, store = new MemoryColumnStore();
  // Two instruments over three days, the second sparse (a minute in five), and a gap of an hour in the first.
  for (let t = T0; t < NOW - MIN; t += MIN) {
    if (!(t >= T0 + 30 * HOUR && t < T0 + 31 * HOUR)) store.save('a:BTC', columnAt(t, 4_000), 20);
    if (Math.floor(t / MIN) % 5 === 0) store.save('b:BTC', columnAt(t, 4_100), 20);
  }
  const now = () => NOW;
  const all = new DepthRecorder({ store: holdingOnly(store), now, retentionMs: 7 * DAY });
  const back = new DepthRecorder({ store, now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  assert.ok((back.columns.get('a:BTC')?.length ?? 0) <= 6 * 60 + 1, 'memory holds six hours');
  assert.deepEqual(back.coverage(), all.coverage(), 'first and last minute, from the store');
  assert.deepEqual([...back.steps], [...all.steps]);
  const windows: [number, number, number][] = [
    [NOW - 2 * HOUR, NOW + MIN, MIN], [NOW - 9 * HOUR, NOW - 3 * HOUR, MIN], [T0 + 29 * HOUR + 13 * MIN, T0 + 33 * HOUR, 2 * MIN],
    [T0, NOW + MIN, 16 * MIN], [T0 - DAY, NOW + 2 * DAY, 64 * MIN], [T0 + 5 * HOUR + 7 * MIN, NOW - 7 * MIN, 4 * MIN], [NOW + HOUR, NOW + 2 * HOUR, 8 * MIN],
  ];
  for (const round of [1, 2]) for (const [from, to, step] of windows) for (const id of ['a:BTC', 'b:BTC']) {
    assert.deepEqual(back.query(id, from, to, step), all.query(id, from, to, step), `round ${round}, ${id}, ${(from - T0) / MIN}..${(to - T0) / MIN} min at ${step / MIN}`);
  }
  // Asked again, the hours read back and the windows merged answer without the store: only the hour that reaches into what memory holds is
  // read again (it is not kept, since its minutes in memory leave for the store later), at most an hour's columns a question.
  const rows = store.rowsRead;
  for (const [from, to, step] of windows) for (const id of ['a:BTC', 'b:BTC']) back.query(id, from, to, step);
  assert.ok(store.rowsRead - rows <= windows.length * 2 * 60, `asked again, ${store.rowsRead - rows} columns read`);
  const reads = store.reads;
  for (const id of ['a:BTC', 'b:BTC']) back.query(id, T0, T0 + DAY, 4 * MIN);
  assert.equal(store.reads, reads, 'a day wholly before what memory holds is answered without the store');
});

test('the step an instrument was recorded on is that of its oldest minute in the retention, held in memory or not', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryColumnStore();
  store.save('x:ETH', columnAt(T0 + HOUR, 300), 0.5);
  store.save('x:ETH', columnAt(NOW - HOUR, 300), 1);
  const back = new DepthRecorder({ store, now: () => NOW, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => NOW, retentionMs: 7 * DAY });
  assert.equal(back.steps.get('x:ETH'), 0.5);
  assert.equal(all.steps.get('x:ETH'), 0.5);
});

const side = (rows: [number, number][]): SideLevels => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[0])), usd: Float64Array.from(rows.map(r => r[1])) });
const book = (t: number, usd: number): ValuedBook => ({ instrumentId: 'x:BTC', venue: 'x', timestamp: t, coarse: false, bids: side([[85_000, usd]]), asks: side([[85_100, usd / 2]]) });

test('a depth column leaves memory only once the store has it, and a minute reopened after a restart keeps its samples', () => {
  const store = new MemoryColumnStore();
  let now = T0;
  const recorder = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  recorder.steps.set('x:BTC', 20);
  // Twenty minutes recorded while the store refuses every column: they stay in memory past the ten held, and answer as ever.
  store.failing = true;
  for (let m = 0; m <= 20; m++) { now = T0 + m * MIN; recorder.sample([book(now, 1_000 + m)], now); }
  recorder.prune(now);
  assert.equal(recorder.columns.get('x:BTC')!.length, 20, 'none the store has not taken is let go');
  assert.equal(recorder.query('x:BTC', T0, T0 + 5 * MIN).length, 5);
  // The store takes them with the next column; then the older ones go, and the store answers for them.
  store.failing = false;
  now = T0 + 21 * MIN; recorder.sample([book(now, 9)], now);
  recorder.prune(now);
  assert.ok(recorder.columns.get('x:BTC')![0]!.t >= now - 10 * MIN, 'memory holds ten minutes again');
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + 5 * MIN).map(c => [c.t, c.n, c.bid[0]]), [0, 1, 2, 3, 4].map(m => [T0 + m * MIN, 1, 1_000 + m]));
  // A restart within a minute: the column written as the process went away is reopened and the minute goes on counting its samples.
  now = T0 + 22 * MIN + 10_000; recorder.sample([book(now, 50)], now); recorder.flush();
  const again = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  now += SAMPLE_MS; again.sample([book(now, 150)], now);
  const open = again.query('x:BTC', T0 + 22 * MIN, T0 + 23 * MIN);
  assert.deepEqual([open.length, open[0]!.n, open[0]!.bid[0]], [1, 2, 100], 'two samples, the mean of 50 and 150');
});

test('an hour read back is answered whole after memory has let go of more of it', () => {
  // The hour that reaches into what memory holds is read from the store only up to memory; were it kept so, the minutes memory lets go of
  // at the next prune would be missing from it.
  const NOW = T0 + 2 * DAY + 25 * MIN, store = new MemoryColumnStore();
  for (let t = T0; t < NOW; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  let now = NOW;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => now, retentionMs: 7 * DAY });
  const window: [number, number] = [NOW - 9 * HOUR, NOW - 2 * HOUR];
  assert.deepEqual(back.query('a:BTC', ...window, MIN), all.query('a:BTC', ...window, MIN));
  now = NOW + 3 * HOUR; back.prune(now); all.prune(now);
  assert.deepEqual(back.query('a:BTC', ...window, MIN).map(c => c.t), all.query('a:BTC', ...window, MIN).map(c => c.t), 'every minute of the window, after memory let go of three more hours');
  assert.deepEqual(back.query('a:BTC', ...window, 4 * MIN), all.query('a:BTC', ...window, 4 * MIN));
});

test('prune moves the first minute on and lets go of the hours read back before it', () => {
  const NOW = T0 + 3 * DAY, store = new MemoryColumnStore();
  for (let t = T0; t < NOW; t += 10 * MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  let now = NOW;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 2 * DAY, memoryMs: 6 * HOUR });
  assert.equal(back.coverage()['a:BTC']!.first, T0 + DAY, 'the store from the retention on');
  assert.ok(back.query('a:BTC', T0, NOW, 16 * MIN).length > 0);
  now = NOW + 12 * HOUR; back.prune(now);
  assert.equal(back.coverage()['a:BTC']!.first, T0 + DAY + 12 * HOUR);
  assert.deepEqual(back.query('a:BTC', T0, T0 + DAY + 12 * HOUR, MIN), [], 'nothing before the retention, kept or stored');
});

/** A footprint store in memory that reads back; rows are kept as written (copied), and saving can be made to fail. */
class MemoryFootprintStore implements FootprintStore {
  readonly rows = new Map<string, FootprintMinuteRow>();
  failing = false; reads = 0;
  load(since: number): FootprintMinuteRow[] { return [...this.rows.values()].filter(r => r.t >= since).sort((a, b) => a.inst.localeCompare(b.inst) || a.t - b.t).map(r => structuredClone(r)); }
  save(rows: FootprintMinuteRow[], expireBefore: number): void {
    if (this.failing) throw new Error('disk full');
    for (const row of rows) this.rows.set(`${row.inst}|${row.t}`, structuredClone(row));
    for (const [key, row] of this.rows) if (row.t < expireBefore) this.rows.delete(key);
  }
  close(): void {}
  range(inst: string, from: number, to: number): FootprintMinuteRow[] { this.reads++; return [...this.rows.values()].filter(r => r.inst === inst && r.t >= from && r.t < to).sort((a, b) => a.t - b.t).map(r => ({ ...structuredClone(r), stats: null })); }
}
const holdingRows = (store: MemoryFootprintStore): FootprintStore => ({ load: s => store.load(s), save: (r, e) => store.save(r, e), close: () => {} });

/** Two days of trades on two instruments, recorded by a recorder that writes them to `store` (orders counted by price from the start). */
function recordTrades(store: MemoryFootprintStore, end: number): void {
  seed = 11;
  let now = T0;
  const writer = new FootprintRecorder(store, () => now, 7 * DAY);
  let id = 0;
  for (let t = T0; t < end; t += 90_000) {
    now = t;
    for (const inst of ['a:BTC', 'b:BTC']) {
      const price = 84_000 + Math.round(rnd() * 400) / 2, usd = 1_000 + Math.round(rnd() * 400_000), side = rnd() < 0.5 ? 'buy' : 'sell';
      writer.ingest([{ instrumentId: inst, tradeId: `t${id}`, side, price, notionalUsd: usd, sourceTimestamp: t }]);
      writer.countOrders([{ instrumentId: inst, side: side as 'buy' | 'sell', t, usd, price }]);
      id++;
    }
    if (t % (20 * MIN) === 0) writer.flush();
  }
  now = end; writer.flush(true);
}

test('reading footprint rows back gives every answer that holding the week gave', () => {
  const NOW = T0 + 2 * DAY + 7 * MIN, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const now = () => NOW, ids = ['a:BTC', 'b:BTC'];
  const all = new FootprintRecorder(holdingRows(store), now, 7 * DAY), back = new FootprintRecorder(store, now, 7 * DAY, 1, 6 * HOUR);
  assert.deepEqual([...back.instruments].sort(), [...all.instruments].sort());
  for (const id of ids) assert.deepEqual([back.lastMinute(id), back.step(id)], [all.lastMinute(id), all.step(id)]);
  for (const round of [1, 2]) {
    for (const [from, to] of [[NOW - 3 * HOUR, NOW + MIN], [NOW - 9 * HOUR, NOW - 3 * HOUR], [T0 + 13 * MIN, NOW], [T0 - DAY, T0 + 30 * HOUR + 3 * MIN]]) {
      for (const id of ids) assert.deepEqual(back.query(id, from!, to!, 15 * MIN, 10, [50_000]), all.query(id, from!, to!, 15 * MIN, 10, [50_000]), `round ${round} bars ${id}`);
      assert.deepEqual(back.profile(ids, from!, to!, 10), all.profile(ids, from!, to!, 10), `round ${round} profile`);
      assert.deepEqual(back.range(ids, from!, to!, null, 20), all.range(ids, from!, to!, null, 20), `round ${round} range`);
      assert.deepEqual(back.range(ids, from!, to!, { p0: 84_050, p1: 84_120 }, 5), all.range(ids, from!, to!, { p0: 84_050, p1: 84_120 }, 5), `round ${round} box`);
    }
    const days = [{ from: T0, to: T0 + DAY }, { from: T0 + DAY, to: T0 + 2 * DAY }, { from: T0 + 2 * DAY, to: T0 + 3 * DAY }];
    assert.deepEqual(back.valueAreas(ids, days, 10, 0.7), all.valueAreas(ids, days, 10, 0.7), `round ${round} value areas`);
    assert.deepEqual(back.sizes(ids, [60, 1_440], [50_000]), all.sizes(ids, [60, 1_440], [50_000]), `round ${round} sizes`);
  }
});

test('a late trade or order into a minute only the store holds is written with all of that minute, and is not answered from a kept hour', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 10 * HOUR + 3 * MIN, before = structuredClone(store.rows.get(`a:BTC|${minute}`)!);
  assert.ok(before.bins.every(b => b.length === 5), 'a minute that counts orders by price');
  const sum = (row: FootprintMinuteRow, at: number) => row.bins.reduce((s, b) => s + (b[at] ?? 0), 0);
  const volume = (row: FootprintMinuteRow) => sum(row, 1) + sum(row, 2), orders = (row: FootprintMinuteRow) => sum(row, 3) + sum(row, 4);
  const traded = () => { const a = back.range(['a:BTC'], minute, minute + MIN, null, 20).instruments[0]!.band; return a.buy + a.sell; };
  assert.ok(volume(before) > 0 && orders(before) > 0);
  // The hour is read back (and kept) first, as a question would.
  assert.ok(Math.abs(traded() - volume(before)) < 1e-6);
  // A late trade of $123,456 bought at a new price, and an order begun there; then the minute is written and memory lets it go.
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'late', side: 'buy', price: 85_555, notionalUsd: 123_456, sourceTimestamp: minute + 30_000 }]);
  back.countOrders([{ instrumentId: 'a:BTC', side: 'buy', t: minute + 30_000, usd: 123_456, price: 85_555 }]);
  // Asked before it is written: answered from memory (the hour may be read back and kept again meanwhile, with the minute as it was).
  assert.ok(Math.abs(traded() - volume(before) - 123_456) < 1e-6, 'the old volume and the new, before it is written');
  back.range(['a:BTC'], minute - HOUR, minute + HOUR, null, 20);
  back.flush();
  const after = store.rows.get(`a:BTC|${minute}`)!;
  assert.ok(Math.abs(volume(after) - volume(before) - 123_456) < 1e-6, 'the old volume and the new, written');
  assert.ok(after.bins.every(b => b.length === 5), 'still counted by price');
  assert.equal(orders(after), orders(before) + 1, 'the orders counted before, and the new one');
  assert.equal(after.stats!.buyN, before.stats!.buyN + 1);
  // Asked again, the minute is answered as it is now, not as the kept hour had it.
  assert.ok(Math.abs(traded() - volume(after)) < 1e-6);
});

test('a footprint minute the store has not taken stays in memory past the hours held', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 5 * HOUR;
  const bought = () => { const a = back.range(['a:BTC'], minute, minute + MIN, null, 20).instruments[0]!.band; return a.buy + a.sell; };
  const base = bought();
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'late-2', side: 'buy', price: 84_100, notionalUsd: 50_000, sourceTimestamp: minute + 5_000 }]);
  store.failing = true;
  assert.throws(() => back.flush(), /disk full/);
  now += HOUR; assert.throws(() => back.flush(), /disk full/);
  assert.ok(Math.abs(bought() - base - 50_000) < 1e-6, 'still answered with the late trade');
  store.failing = false; back.flush();
  assert.ok(Math.abs(bought() - base - 50_000) < 1e-6, 'and, once written, from the store');
});
