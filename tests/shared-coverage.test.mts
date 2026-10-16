import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_PASS_GAP_MS, TradeCoverage, complement, coversAll, depthAnswer, minuteState, parseCoverage, union, type CoverageRow, type CoverageStore } from '../src/shared/coverage.ts';
import { TradeCoverage as ServerCoverage } from '../src/server/v2/coverage.mts';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';

const MINUTE = 60_000, BASE = Date.UTC(2026, 9, 16, 12, 0, 0);

/** Live passes every 250 ms over [from, to). */
function passes(c: TradeCoverage, id: string, from: number, to: number, live = true): void { for (let t = from; t < to; t += 250) c.pass(id, live, t); }

test('live passes make one stretch; a pass that comes too late (a frozen page) starts another, and the time between is not covered', () => {
  const c = new TradeCoverage();
  passes(c, 'x', BASE, BASE + 10_000);
  c.pass('x', true, BASE + 10_000 + MAX_PASS_GAP_MS + 1);
  passes(c, 'x', BASE + 20_000, BASE + 30_000);
  assert.deepEqual(c.covered('x', BASE, BASE + MINUTE), [[BASE, BASE + 9_750], [BASE + 20_000, BASE + 29_750]]);
  assert.deepEqual(complement(c.covered('x', BASE, BASE + MINUTE), BASE, BASE + MINUTE), [[BASE + 9_750, BASE + 20_000], [BASE + 29_750, BASE + MINUTE]]);
});

test('a feed that fails is covered only up to its last message, and a stretch that covered nothing goes', () => {
  const c = new TradeCoverage();
  passes(c, 'x', BASE, BASE + 60_000);
  // Called failed after 90 s of silence: its last message was 40 s in.
  c.pass('x', false, BASE + 60_000, BASE + 40_000);
  assert.deepEqual(c.covered('x', BASE, BASE + 2 * MINUTE), [[BASE, BASE + 40_000]]);
  c.pass('x', true, BASE + 70_000); c.pass('x', false, BASE + 70_000);
  assert.equal(c.spans('x').length, 1, 'opened and closed on one pass: nothing covered, nothing kept');
  c.pass('x', true, BASE + 80_000); c.end('x', BASE + 81_000);
  assert.deepEqual(c.covered('x', BASE, BASE + 2 * MINUTE).at(-1), [BASE + 80_000, BASE + 81_000], 'switched off on purpose: covered up to then');
});

test('each stretch keeps its first and last trade, and a gap is bounded by the trades either side of it', () => {
  const c = new TradeCoverage();
  passes(c, 'x', BASE, BASE + 20_000);
  c.trade('x', '100', BASE + 1_000, BASE + 1_000); c.trade('x', '101', BASE + 15_000, BASE + 15_000);
  // Frozen for a minute: what the socket held arrives before the first pass and is credited to no stretch. Then live again.
  c.trade('x', '180', BASE + 40_000, BASE + 80_000);
  passes(c, 'x', BASE + 80_000, BASE + 100_000);
  c.trade('x', '250', BASE + 80_500, BASE + 80_500);
  const gaps = c.gaps('x', BASE, BASE + 99_750);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { from: BASE + 19_750, to: BASE + 80_000, before: { id: '101', t: BASE + 15_000 }, after: { id: '250', t: BASE + 80_500 } });
  // A window that starts inside the gap is bounded by its own start (by time), not by a trade before it.
  const late = c.gaps('x', BASE + 30_000, BASE + 99_750);
  assert.deepEqual(late[0], { from: BASE + 30_000, to: BASE + 80_000, before: null, after: { id: '250', t: BASE + 80_500 } });
  // A gap up to the window's end (no live stretch after it yet) has no trade after it.
  const open = c.gaps('x', BASE, BASE + 60_000);
  assert.equal(open[0]!.after, null);
});

test('recovered stretches are covered and told apart from live ones', () => {
  const c = new TradeCoverage();
  passes(c, 'x', BASE, BASE + 20_000);
  passes(c, 'x', BASE + 80_000, BASE + 100_000);
  c.recovered('x', BASE + 19_750, BASE + 80_000, { id: '102', t: BASE + 19_800 }, { id: '249', t: BASE + 79_900 });
  assert.deepEqual(c.covered('x', BASE, BASE + 100_000), [[BASE, BASE + 99_750]]);
  assert.deepEqual(c.covered('x', BASE, BASE + 100_000, 'recovered'), [[BASE + 19_750, BASE + 80_000]]);
  assert.equal(c.gaps('x', BASE, BASE + 99_750).length, 0);
});

/** A store in memory that keeps what was written, by key, as IndexedDB and SQLite do. */
function memoryStore(initial: CoverageRow[] = []): CoverageStore & { rows: Map<string, CoverageRow> } {
  const rows = new Map(initial.map(r => [`${r.inst}|${r.metric}|${r.from}`, r]));
  return { rows, load: since => [...rows.values()].filter(r => r.to >= since), save: (list, expire) => { for (const r of list) rows.set(`${r.inst}|${r.metric}|${r.from}`, r); for (const [k, r] of rows) if (r.to < expire) rows.delete(k); }, close: () => {} };
}

test('a stretch is written cut at the minute still open, naming the last trade before it; whole once that minute has ended or when the page goes', () => {
  let now = BASE + 90_000;
  const store = memoryStore(), c = new TradeCoverage(store, () => now);
  passes(c, 'x', BASE, BASE + 90_000);
  c.trade('x', 'a', BASE + 30_000, BASE + 30_000); c.trade('x', 'b', BASE + 59_000, BASE + 59_000); c.trade('x', 'c', BASE + 70_000, BASE + 70_000);
  c.flush();
  const cut = store.rows.get(`x|trades|${BASE}`)!;
  assert.equal(cut.to, BASE + MINUTE, 'the open minute (12:01) is not claimed: its trades are not stored yet');
  assert.deepEqual(cut.last, { id: 'b', t: BASE + 59_000 }, 'the seam is the last trade the stored minutes hold');
  now = BASE + 2 * MINUTE + 1_000; passes(c, 'x', BASE + 90_000, now);
  c.flush(true);
  assert.equal(store.rows.get(`x|trades|${BASE}`)!.to, now - 250);
  assert.deepEqual(store.rows.get(`x|trades|${BASE}`)!.last, { id: 'c', t: BASE + 70_000 });
  // A reload reads the stretch back: closed, so the next live pass opens a new one and the time between is a gap.
  const again = new TradeCoverage(store, () => now);
  again.pass('x', true, now + 30_000); again.pass('x', true, now + 30_250);
  assert.deepEqual(again.gaps('x', BASE, now + 30_250).map(g => [g.from, g.to, g.before?.id]), [[now - 250, now + 30_000, 'c']]);
});

test('the server keeps the stretches in its history database and reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-')), file = path.join(dir, 'depth-v2.sqlite');
  let now = BASE + 3 * MINUTE;
  try {
    const c = new ServerCoverage(file, () => now);
    passes(c, 'binance:BTCUSDT', BASE, BASE + 2 * MINUTE);
    c.trade('binance:BTCUSDT', '7', BASE + 61_000, BASE + 61_000);
    c.recovered('okx:BTC-USDT-SWAP', BASE, BASE + MINUTE, { id: '1', t: BASE + 1 }, { id: '9', t: BASE + 59_999 });
    c.close();
    now += 1_000;
    const back = new ServerCoverage(file, () => now);
    assert.deepEqual(back.covered('binance:BTCUSDT', BASE, BASE + 3 * MINUTE), [[BASE, BASE + 2 * MINUTE - 250]]);
    assert.deepEqual(back.spans('binance:BTCUSDT')[0]!.last, { id: '7', t: BASE + 61_000 });
    assert.deepEqual(back.spans('okx:BTC-USDT-SWAP'), [{ from: BASE, to: BASE + MINUTE, kind: 'recovered', first: { id: '1', t: BASE + 1 }, last: { id: '9', t: BASE + 59_999 } }]);
    back.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A connector with no socket: live once it has a book, its trades handed in by the test. */
class Fake extends BookConnector {
  readonly name = 'fake'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage(text: string) { const m = JSON.parse(text) as { bids: [number, number][]; asks: [number, number][] }; this.replace(this.bids, m.bids); this.replace(this.asks, m.asks); this.touch(); }
  book() { this.onMessage(JSON.stringify({ bids: [[100, 5]], asks: [[101, 5]] })); }
  trade(tradeId: string, t: number, side: 'buy' | 'sell' = 'buy') { this.onTrade({ instrumentId: this.instrumentId, tradeId, side, price: 100.5, amount: 1, notionalUsd: 100.5, t } satisfies TradeEvent); }
}

test('the engine tells a minute recorded with nothing in it from one nobody recorded, and a frozen loop leaves a gap', () => {
  let clock = BASE;
  const fakes = new Map<string, Fake>();
  const venues: BrowserVenue[] = [{ id: 'binance', name: 'binance', kind: 'perp', recommended: true, listed: true, probe: null, make: () => { const book = new Fake('binance'); fakes.set('binance', book); return { book, feeds: [] }; } }];
  const engine = new Engine({ venues, now: () => clock, ping: async () => true, get: async () => { throw new Error('offline'); } });
  engine.select(['binance']);
  const fake = fakes.get('binance')!, id = fake.instrumentId;
  fake.book();
  const run = (to: number): void => { for (; clock < to; clock += 250) { fake.book(); engine.step(clock); } };
  run(BASE + 10_000); fake.trade('1', BASE + 10_000);
  run(BASE + 2 * MINUTE + 30_000); fake.trade('2', BASE + 2 * MINUTE + 30_000);
  run(BASE + 3 * MINUTE + 1);
  // The page is frozen for two minutes: no pass runs.
  clock = BASE + 5 * MINUTE + 20_000;
  run(BASE + 6 * MINUTE + 1);
  const answer = engine.coverage([id], 'trades', BASE, BASE + 6 * MINUTE).instruments[0]!;
  assert.deepEqual(answer.seconds, [60, 60, 60, 0, 0, 40]);
  assert.deepEqual(answer.held, [true, false, true, false, false, false]);
  assert.deepEqual(answer.seconds.map((s, i) => minuteState(s, answer.held[i]!)), ['recorded', 'empty', 'recorded', 'missing', 'missing', 'partial']);
  assert.ok(coversAll(answer.spans, BASE, BASE + 3 * MINUTE) && !coversAll(answer.spans, BASE, BASE + 4 * MINUTE));
  // Depth from the columns' samples: twelve a minute while the book was sampled (the pass at 12:03:00 took one), none while frozen.
  const depth = engine.coverage([id], 'depth', BASE, BASE + 6 * MINUTE).instruments[0]!;
  assert.deepEqual(depth.seconds.slice(0, 5), [60, 60, 60, 5, 0]);
  assert.equal(depth.held[4], false);
});

test('depth answers come from sample counts; a minute with no column is not recorded', () => {
  const a = depthAnswer('x', new Map([[BASE, { n: 12, levels: true }], [BASE + MINUTE, { n: 5, levels: true }], [BASE + 3 * MINUTE, { n: 12, levels: false }]]), BASE, BASE + 4 * MINUTE);
  assert.deepEqual(a.seconds, [60, 25, 0, 60]);
  assert.deepEqual(a.held, [true, true, false, false]);
  assert.deepEqual(a.spans, [[BASE, BASE + MINUTE], [BASE + 3 * MINUTE, BASE + 4 * MINUTE]]);
  assert.deepEqual([minuteState(60, false), minuteState(0, true), minuteState(30, true)], ['empty', 'unknown', 'partial']);
});

test('a coverage answer is checked field by field against the question', () => {
  const good = { metric: 'trades', from: BASE, to: BASE + 2 * MINUTE, asOf: BASE + 90_000, instruments: [{ id: 'a', spans: [[BASE, BASE + 90_000]], recovered: [], seconds: [60, 30], held: [true, false] }] };
  assert.ok(parseCoverage(good, ['a'], 'trades', BASE + 5, BASE + 90_000));
  assert.equal(parseCoverage({ ...good, metric: 'depth' }, ['a'], 'trades', BASE, BASE + 2 * MINUTE), null);
  assert.equal(parseCoverage({ ...good, instruments: [{ ...good.instruments[0], seconds: [61, 0] }] }, ['a'], 'trades', BASE, BASE + 2 * MINUTE), null);
  assert.equal(parseCoverage({ ...good, instruments: [{ ...good.instruments[0], id: 'b' }] }, ['a'], 'trades', BASE, BASE + 2 * MINUTE), null);
  assert.equal(parseCoverage({ ...good, instruments: [{ ...good.instruments[0], spans: [[BASE - 1, BASE]] }] }, ['a'], 'trades', BASE, BASE + 2 * MINUTE), null);
  assert.equal(parseCoverage('<html>', ['a'], 'trades', BASE, BASE + 2 * MINUTE), null);
  assert.deepEqual(union([{ from: 5, to: 9 }, { from: 1, to: 3 }, { from: 3, to: 6 }], 0, 8), [[1, 8]]);
});
