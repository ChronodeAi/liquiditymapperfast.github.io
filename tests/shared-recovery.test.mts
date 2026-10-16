import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOVERY_BUDGET, compareIds, historySource, planRecovery, rebuildOrders, runRecovery, trimUnknown, type HistoryFetch, type HistorySource, type PageRequest, type RecoveryJob } from '../src/shared/recovery.ts';
import { BTC } from '../src/shared/coins.ts';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { TapeBatch } from '../src/shared/tape.ts';

const BASE = Date.UTC(2026, 9, 16, 12, 0, 0), MINUTE = 60_000;
const src = (venue: keyof typeof BTC.markets): HistorySource => historySource(venue, BTC.markets[venue]!)!;

test('each venue\'s page is read as the live connector reads its socket: the taker\'s side, one coin\'s price and amount, the same trade id', () => {
  const binance = src('binance').parse([{ a: 3488176686, p: '81568.30', q: '0.004', T: BASE, m: true }, { a: 3488176687, p: '81568.40', q: '0.048', T: BASE + 1, m: false }])!;
  assert.deepEqual(binance.map(r => [r.tradeId, r.side, r.amount]), [['3488176686', 'sell', 0.004], ['3488176687', 'buy', 0.048]], 'm: the buyer was the maker, so the taker sold');
  const okx = src('okx').parse({ code: '0', data: [{ tradeId: '3001706124', px: '81576.1', sz: '0.61', side: 'sell', ts: String(BASE) }] })!;
  assert.equal(okx[0]!.amount.toFixed(4), '0.0061', 'OKX swap sizes are contracts of 0.01 BTC');
  assert.equal(okx[0]!.notionalUsd.toFixed(2), (81576.1 * 0.0061).toFixed(2));
  assert.equal(src('okx').parse({ code: '50011', msg: 'Rate limit reached', data: [] }), null, 'a rate limit answered with 200 is not a page');
  const coinbase = src('coinbase').parse([{ trade_id: 1107113124, side: 'buy', size: '0.1', price: '81516.99', time: '2026-10-16T12:00:00.026015Z' }])!;
  assert.equal(coinbase[0]!.side, 'sell', 'Coinbase names the maker\'s side');
  assert.equal(coinbase[0]!.t, BASE + 26);
  const bitget = src('bitget').parse({ code: '00000', data: [{ tradeId: '1495083999036194816', price: '81578.7', size: '0.0203', side: 'Buy', ts: String(BASE) }] })!;
  assert.deepEqual([bitget[0]!.tradeId, bitget[0]!.side], ['1495083999036194816', 'buy']);
  const bybit = src('bybit').parse({ retCode: 0, result: { list: [{ execId: 'ce4b', price: '81590.3', size: '0.012', side: 'Sell', time: String(BASE), seq: '827352153470' }] } })!;
  assert.deepEqual([bybit[0]!.side, bybit[0]!.order], ['sell', '827352153470'], 'the matching event names the order, as on the socket');
  const hl = src('hyperliquid').parse([{ coin: 'BTC', side: 'B', px: '81593.0', sz: '0.06824', time: BASE, hash: '0x00', tid: 328394906938076 }])!;
  assert.deepEqual([hl[0]!.tradeId, hl[0]!.side, hl[0]!.order], [`${BASE}:BTC:328394906938076`, 'buy', undefined], 'the socket\'s id; an all-zero hash names no order');
  assert.equal(historySource('deribit', BTC.markets.deribit!), null, 'not read back');
  // A coin listed in thousands: price per coin, amount in coins, as the connector converts them.
  const pepe = historySource('binance', { symbol: '1000PEPEUSDT', unit: 1000 })!.parse([{ a: 1, p: '0.01', q: '5', T: BASE, m: false }])!;
  assert.deepEqual([pepe[0]!.price, pepe[0]!.amount, pepe[0]!.notionalUsd], [0.00001, 5000, 0.05]);
});

test('trade ids are compared as whole numbers past what a double holds', () => {
  assert.ok(compareIds('1495083999036194816', '1495083999036194817') < 0);
  assert.ok(compareIds('999', '1000') < 0);
  assert.equal(compareIds('007', '7'), 0);
});

/** A venue whose history holds trades with ids `lo`..`hi` at `t(id)`, answered as `source` pages them (newest first back, oldest first forward). */
function history(lo: number, hi: number, t: (id: number) => number, opts: { pageRows?: number; delayMs?: number; onCall?: (r: PageRequest) => void } = {}) {
  let calls = 0, inflight = 0, most = 0;
  const fetcher: HistoryFetch = async request => {
    calls++; inflight++; most = Math.max(most, inflight); opts.onCall?.(request);
    if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
    inflight--;
    const url = new URL(request.url), limit = opts.pageRows ?? Number(url.searchParams.get('limit') ?? 100);
    if (url.hostname === 'www.okx.com') {
      const after = url.searchParams.get('after'), top = after ? Number(after) - 1 : hi, ids: number[] = [];
      for (let id = top; id >= lo && ids.length < limit; id--) ids.push(id);
      return { ok: true, status: 200, body: { code: '0', data: ids.map(id => ({ tradeId: String(id), px: '81000', sz: '1', side: id % 2 ? 'buy' : 'sell', ts: String(t(id)) })) } };
    }
    const fromId = url.searchParams.get('fromId'), start = url.searchParams.get('startTime'), ids: number[] = [];
    let id = fromId ? Number(fromId) : lo; if (start) while (id <= hi && t(id) < Number(start)) id++;
    for (; id <= hi && ids.length < limit; id++) ids.push(id);
    return { ok: true, status: 200, body: ids.map(i => ({ a: i, p: '81000', q: '0.01', T: t(i), m: i % 2 === 0 })) };
  };
  return { fetcher, stats: () => ({ calls, most }) };
}
const job = (source: HistorySource, gap: Partial<RecoveryJob> = {}): RecoveryJob => ({ id: 'x', source, from: BASE, to: BASE + MINUTE, before: null, after: null, window: 0, ...gap });
const noSleep = async (): Promise<void> => {};

test('the seam: only the trades between the last one recorded before the gap and the first after it, by id, are taken', async () => {
  const t = (id: number): number => BASE + id * 100;
  // OKX pages back from the first trade recorded after the gap (id 300) until a page reaches the last one before it (id 110).
  const okx = history(0, 400, t), back = await runRecovery([job(src('okx'), { from: t(110), to: t(300), before: { id: '110', t: t(110) }, after: { id: '300', t: t(300) } })], okx.fetcher, { sleep: noSleep });
  assert.deepEqual(back.results[0]!.rows.map(r => Number(r.tradeId)), Array.from({ length: 189 }, (_, i) => 111 + i));
  assert.equal(back.results[0]!.complete, true); assert.deepEqual(back.results[0]!.covered, [t(110), t(300)]);
  assert.equal(okx.stats().calls, 2, 'pages of 100: 299..200, then 199..100, which reaches past the seam');
  // Binance pages forward from the trade after the last one recorded until a row is the first recorded after the gap.
  const bin = history(0, 4_000, t), fwd = await runRecovery([job(src('binance'), { from: t(110), to: t(300), before: { id: '110', t: t(110) }, after: { id: '300', t: t(300) } })], bin.fetcher, { sleep: noSleep });
  assert.deepEqual([fwd.results[0]!.rows[0]!.tradeId, fwd.results[0]!.rows.at(-1)!.tradeId, fwd.results[0]!.rows.length], ['111', '299', 189]);
  assert.equal(bin.stats().calls, 1);
  // From a window's edge (no trade recorded before it): by time.
  const edge = await runRecovery([job(src('binance'), { from: t(150), to: t(300), after: { id: '300', t: t(300) } })], history(0, 4_000, t).fetcher, { sleep: noSleep });
  assert.equal(edge.results[0]!.rows[0]!.tradeId, '150');
});

test('a budget-stopped gap applies only the part next to the seam it started from, and claims only that', async () => {
  const t = (id: number): number => BASE + id * 10;
  const run = await runRecovery([job(src('okx'), { from: t(0), to: t(1_000), before: { id: '0', t: t(0) }, after: { id: '1000', t: t(1_000) } })], history(0, 2_000, t).fetcher, { sleep: noSleep, budget: { ...RECOVERY_BUDGET, pages: 3 } });
  const r = run.results[0]!;
  assert.equal(run.stoppedBy, 'pages'); assert.equal(r.complete, false);
  assert.deepEqual(r.covered, [t(700) + 1, t(1_000)], 'three pages back from 999: down to 700, whose millisecond may hold more on the next page');
  assert.ok(r.rows.every(x => Number(x.tradeId) > 700 && Number(x.tradeId) < 1_000));
});

test('one action reads at most 20 pages, 20,000 rows or 30 s, two requests in flight, each venue paced', async () => {
  const t = (id: number): number => BASE + id;
  const many = Array.from({ length: 8 }, (_, i) => job(src(i % 2 ? 'binance' : 'binancespot'), { id: `m${i}`, from: t(0), to: t(1_000_000) }));
  // Pages: every venue has endless full pages.
  const endless = history(0, 10_000_000, t, { delayMs: 2 }), byPages = await runRecovery(many, endless.fetcher, { sleep: noSleep });
  assert.equal(byPages.stoppedBy, 'pages'); assert.equal(byPages.pages, 20); assert.equal(endless.stats().calls, 20);
  assert.ok(byPages.rows <= 20_000);
  assert.ok(endless.stats().most <= 2, `${endless.stats().most} requests in flight`);
  // Rows: a page is not asked for when its rows would pass the ceiling.
  const byRows = await runRecovery(many, history(0, 10_000_000, t).fetcher, { sleep: noSleep, budget: { ...RECOVERY_BUDGET, pages: 100, rows: 2_500 } });
  assert.equal(byRows.stoppedBy, 'rows'); assert.equal(byRows.rows, 2_000);
  // Time: each answer takes 4 s of the clock.
  let clock = 0;
  const slow = history(0, 10_000_000, t, { onCall: () => { clock += 4_000; } });
  const byTime = await runRecovery(many, slow.fetcher, { sleep: noSleep, now: () => clock, budget: { ...RECOVERY_BUDGET, pages: 100, rows: 1e9 } });
  assert.equal(byTime.stoppedBy, 'time'); assert.ok(byTime.ms >= 30_000 && byTime.pages <= 9, `${byTime.pages} pages in ${byTime.ms} ms`);
  // Pacing: two gaps of one venue never ask closer together than its pace.
  let at = 0; const times: number[] = [];
  const paced = history(0, 10_000_000, t, { onCall: r => { if (r.url.includes('fapi')) times.push(at); } });
  await runRecovery([job(src('binance'), { id: 'a', from: t(0), to: t(5_000) }), job(src('binance'), { id: 'b', from: t(0), to: t(5_000) })], paced.fetcher, { now: () => at, sleep: async ms => { at += ms; } });
  assert.ok(times.length >= 4 && times.every((x, i) => i === 0 || x - times[i - 1]! >= src('binance').paceMs), times.join(','));
});

test('a venue that fails is asked nothing more in the action, and its gaps claim nothing', async () => {
  let calls = 0;
  const down: HistoryFetch = async () => { calls++; return { ok: false, status: 429, body: null }; };
  const run = await runRecovery([job(src('okx'), { id: 'a' }), job(src('okx'), { id: 'b' })], down, { sleep: noSleep });
  assert.equal(calls, 1); assert.deepEqual(run.failed, ['okx-history-trades']);
  assert.ok(run.results.every(r => r.covered === null && r.rows.length === 0));
  // OKX's swap and spot pages are one endpoint with one limit: a failure on one stops the other too.
  calls = 0;
  const both = await runRecovery([job(src('okx'), { id: 'a' }), job(src('okxspot'), { id: 'b' })], down, { sleep: noSleep });
  assert.equal(calls, 1); assert.deepEqual(both.failed, ['okx-history-trades']);
});

test('markets that share a venue\'s limit are paced as one: OKX swap and spot never ask closer together than its pace', async () => {
  const t = (id: number): number => BASE + id * 10;
  let at = 0; const times: number[] = [];
  const okx = history(0, 100_000, t, { onCall: () => times.push(at) });
  await runRecovery([job(src('okx'), { id: 'a', from: t(0), to: t(800) }), job(src('okxspot'), { id: 'b', from: t(0), to: t(800) })], okx.fetcher, { now: () => at, sleep: async ms => { at += ms; } });
  assert.ok(times.length >= 8, `${times.length} pages`);
  assert.ok(times.every((x, i) => i === 0 || x - times[i - 1]! >= src('okx').paceMs), times.join(','));
  assert.equal(src('okx').bucket, src('okxspot').bucket);
  assert.notEqual(src('binance').bucket, src('binancespot').bucket, 'Binance USD-M and spot are two hosts with two limits');
});

test('the order of an action: the bar under way first, the chart market first, then the venues that page cheaply', () => {
  const gaps = (id: string) => [{ from: BASE, to: BASE + 10_000, before: null, after: null }, { from: BASE + 20_000, to: BASE + 30_000, before: null, after: null }].map(g => ({ ...g, id }));
  const plan = planRecovery([{ from: BASE, to: BASE + MINUTE }, { from: BASE - MINUTE, to: BASE }],
    [{ id: 'okx', source: src('okx') }, { id: 'okx2', source: src('okxspot') }, { id: 'cb', source: src('coinbase') }, { id: 'bybit', source: src('bybit') }], (id, from) => from === BASE ? gaps(id) : []);
  assert.deepEqual(plan.map(j => j.id), ['okx', 'okx', 'bybit', 'bybit', 'cb', 'cb', 'okx2', 'okx2']);
  assert.equal(plan[0]!.from, BASE + 20_000, 'newest gap first');
});

test('minutes held from storage with no record of being covered are not recovered: their trades would count twice', () => {
  const g = trimUnknown([{ from: BASE + 30_000, to: BASE + 4 * MINUTE, before: { id: '1', t: BASE }, after: { id: '9', t: BASE + 4 * MINUTE } }], t => t === BASE + MINUTE || t === BASE + 2 * MINUTE);
  assert.deepEqual(g.map(x => [x.from - BASE, x.to - BASE, x.before?.id ?? null, x.after?.id ?? null]), [[30_000, MINUTE, '1', null], [3 * MINUTE, 4 * MINUTE, null, '9']]);
});

test('recovered fills are rebuilt into orders of their own, by the venue\'s key or the millisecond', () => {
  const orders = rebuildOrders('x', [
    { tradeId: '1', side: 'buy', price: 100, amount: 1, notionalUsd: 100, t: BASE, order: 's1' }, { tradeId: '2', side: 'buy', price: 101, amount: 1, notionalUsd: 101, t: BASE + 3, order: 's1' },
    { tradeId: '3', side: 'sell', price: 100, amount: 2, notionalUsd: 200, t: BASE + 5 }, { tradeId: '4', side: 'sell', price: 99, amount: 1, notionalUsd: 99, t: BASE + 5 },
  ]);
  assert.deepEqual(orders.map(o => [o.side, o.usd, o.fills, o.lo, o.hi]), [['buy', 201, 2, 100, 101], ['sell', 299, 2, 99, 100]]);
});

/** A connector with no socket: live once it has a book, its trades handed in by the test. */
class Fake extends BookConnector {
  readonly name = 'okx'; readonly symbol = 'BTC-USDT-SWAP'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage(text: string) { const m = JSON.parse(text) as { bids: [number, number][]; asks: [number, number][] }; this.replace(this.bids, m.bids); this.replace(this.asks, m.asks); this.touch(); }
  book() { this.onMessage(JSON.stringify({ bids: [[80_990, 5]], asks: [[81_010, 5]] })); }
  trade(tradeId: number, t: number) { this.onTrade({ instrumentId: this.instrumentId, tradeId: String(tradeId), side: tradeId % 2 ? 'buy' : 'sell', price: 81_000, amount: 0.01, notionalUsd: 810, t } satisfies TradeEvent); }
}

test('the engine fills a frozen page\'s gap from the venue\'s history at the seam, in one step, with no flash and no fresh print', async () => {
  let clock = BASE;
  const fakes: Fake[] = [];
  const venues: BrowserVenue[] = [{ id: 'okx', name: 'OKX', kind: 'perp', recommended: true, listed: true, probe: null, make: () => { const book = new Fake('okx'); fakes.push(book); return { book, feeds: [] }; } }];
  const t = (id: number): number => BASE + id * 200;
  // The venue's history: one trade every 200 ms; trade 200 is a whale (50 contracts of 0.01 BTC at 81,000: $40,500).
  const fetcher: HistoryFetch = async request => {
    const url = new URL(request.url), after = url.searchParams.get('after'), top = after ? Number(after) - 1 : 600, ids: number[] = [];
    for (let id = top; id >= 0 && ids.length < 100; id--) ids.push(id);
    return { ok: true, status: 200, body: { code: '0', data: ids.map(id => ({ tradeId: String(id), px: '81000', sz: id === 200 ? '50' : '1', side: id % 2 ? 'buy' : 'sell', ts: String(t(id)) })) } };
  };
  const engine = new Engine({ venues, now: () => clock, ping: async () => true, get: async () => { throw new Error('offline'); }, historyFetch: fetcher });
  const tapes: TapeBatch[] = [], recovered: [string, number, number][] = [];
  engine.onTape = batch => tapes.push(batch);
  engine.onRecovered = (id, from, to) => recovered.push([id, from, to]);
  engine.select(['okx']);
  const fake = fakes[0]!, id = fake.instrumentId;
  const run = (to: number, trades: number[] = []): void => { for (; clock < to; clock += 200) { fake.book(); for (const n of trades) if (t(n) === clock) fake.trade(n, t(n)); engine.step(clock); } };
  // Recorded live: trades 0..100. The page freezes (no pass, no trade taken), then trades from 350 on are recorded live again.
  run(t(101), Array.from({ length: 101 }, (_, i) => i));
  clock = t(350);
  run(t(401), Array.from({ length: 51 }, (_, i) => 350 + i));
  // One more pass hands on the last live order (it closes after 150 ms of quiet): what comes after is the recovery's alone.
  engine.step(clock);
  const livePrints = engine.prints(BASE, BASE + 5 * MINUTE).length; engine.printStream.takeFresh();
  const tapesBefore = tapes.length;
  const gaps = engine.tradeCoverage.gaps(id, BASE, t(400));
  // Trade 350 came as the page woke, before its first pass: recorded, but in no stretch, so the gap's seam is 351 and the recovery's own
  // read of 350 must be dropped as already held (the totals below count it once).
  assert.equal(gaps.length, 1); assert.deepEqual([gaps[0]!.before?.id, gaps[0]!.after?.id], ['100', '351']);

  const report = await engine.recover({ ids: [id], windows: [{ from: BASE, to: t(400) }] });
  assert.equal(report.stoppedBy, 'done'); assert.deepEqual(report.instruments.map(i => [i.gaps, i.recoverable]), [[1, true]]);
  assert.equal(engine.tradeCoverage.gaps(id, BASE, t(400)).length, 0, 'the gap is covered now');
  assert.deepEqual(engine.tradeCoverage.covered(id, BASE, t(400), 'recovered'), [[gaps[0]!.from, gaps[0]!.to]]);
  // Every trade once: 0..400 at $8.10 a contract hundredth, the whale 50 times that.
  const bars = engine.footprint(id, MINUTE, BASE, BASE + 5 * MINUTE, 1).bars, usd = bars.reduce((s, b) => s + b.buyUsd + b.sellUsd, 0);
  assert.equal(Math.round(usd), 401 * 810 + 49 * 810);
  const flow = engine.flow([id], BASE, BASE + 5 * MINUTE).instruments[0]!;
  assert.equal(Math.round([...flow.buy, ...flow.sell].reduce((a, b) => a + b, 0)), 401 * 810 + 49 * 810);
  // Nothing flashed or sounded: no trade-dust batch, and the whale is in the recording but was never handed on as fresh.
  engine.step(clock);
  assert.equal(tapes.length, tapesBefore);
  assert.equal(engine.prints(BASE, BASE + 5 * MINUTE).length, livePrints + 1);
  assert.deepEqual(engine.printStream.takeFresh(), []);
  assert.deepEqual(recovered.map(([rid]) => rid), [id]);
  // Asked again, nothing is left to recover and nothing is counted twice.
  const again = await engine.recover({ ids: [id], windows: [{ from: BASE, to: t(400) }] });
  assert.equal(again.pages, 0);
  assert.equal(Math.round(engine.footprint(id, MINUTE, BASE, BASE + 5 * MINUTE, 1).bars.reduce((s, b) => s + b.buyUsd + b.sellUsd, 0)), 401 * 810 + 49 * 810);
});

test('a market whose recording began a moment after the bar opened has that moment recovered, and the beat at the window\'s end is no gap', async () => {
  let clock = BASE + 21;
  const fakes: Fake[] = [], asked: string[] = [];
  const venues: BrowserVenue[] = [{ id: 'okx', name: 'OKX', kind: 'perp', recommended: true, listed: true, probe: null, make: () => { const book = new Fake('okx'); fakes.push(book); return { book, feeds: [] }; } }];
  // The venue's newest page: trades 10 to 1 at one a second back from 12:00:10, and one 5 s before the bar.
  const fetcher: HistoryFetch = async request => {
    asked.push(request.url);
    const rows = [...Array.from({ length: 10 }, (_, i) => 10 - i), 0].map(n => ({ tradeId: String(n), px: '81000', sz: '1', side: 'buy', ts: String(n === 0 ? BASE - 5_000 : BASE + n * 1_000 - 500) }));
    return { ok: true, status: 200, body: { code: '0', data: rows } };
  };
  const engine = new Engine({ venues, now: () => clock, ping: async () => true, get: async () => { throw new Error('offline'); }, historyFetch: fetcher });
  engine.select(['okx']);
  const fake = fakes[0]!, id = fake.instrumentId;
  for (; clock < BASE + 12_000; clock += 250) { fake.book(); engine.step(clock); }
  assert.deepEqual(engine.tradeCoverage.gaps(id, BASE, clock).map(g => [g.from - BASE, g.to - BASE]), [[0, 21], [11_771, 12_021]]);
  const report = await engine.recover({ ids: [id], windows: [{ from: BASE, to: clock }] });
  assert.equal(asked.length, 1, 'one gap: the 21 ms at the open (the last quarter second is the loop\'s beat)');
  assert.deepEqual(report.instruments[0]!.gaps, 1);
  assert.deepEqual(engine.tradeCoverage.covered(id, BASE, BASE + 11_771), [[BASE, BASE + 11_771]]);
});
