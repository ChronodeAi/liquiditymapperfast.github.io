import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FootprintRecorder } from '../src/server/v2/footprint.mts';
import { FlowRecorder } from '../src/server/v2/flow.mts';
import { PrintStream } from '../src/server/v2/prints.mts';
import { TradeCoverage } from '../src/server/v2/coverage.mts';
import { TradeRecovery } from '../src/server/v2/recovery.mts';
import { RECOVERY_BUDGET, type HistoryFetch } from '../src/shared/recovery.ts';

const MINUTE = 60_000, T0 = Date.UTC(2026, 9, 26, 12, 0, 0), ID = 'okx:BTC-USDT-SWAP';
/** OKX swap trade `n` happens at T0 + n × 200 ms: one contract of 0.01 BTC at 81,000 ($810), trade 200 a whale of 50 ($40,500). */
const t = (n: number): number => T0 + n * 200;
const contracts = (n: number): number => n === 200 ? 50 : 1;
/** USD of trades 0..n, each once. */
const once = (n: number): number => (n + 1) * 810 + (n >= 200 ? 49 * 810 : 0);

type Clock = { now: number };
const recordings = (file: string | null, clock: Clock) => {
  const now = (): number => clock.now;
  return { footprints: new FootprintRecorder(file, now), flows: new FlowRecorder(file, now), prints: new PrintStream(file, now), coverage: new TradeCoverage(file, now) };
};
type Recordings = ReturnType<typeof recordings>;
const shut = (r: Recordings): void => { r.footprints.close(); r.coverage.close(); r.prints.close(); r.flows.close(); };

/** How a market's live feed names trade `n` and which instrument it is (the OKX swap's connector by default). */
interface Market { id: string; name: (n: number) => string }
const OKX: Market = { id: ID, name: String };
/** A trade as the server's loop takes a connector's (api.mts `takeTrade`): the footprint, the flow, and the coverage record's seam. */
function live(r: Recordings, n: number, now: number, market = OKX): void {
  const row = { instrumentId: market.id, tradeId: market.name(n), side: n % 2 ? 'buy' : 'sell', price: 81_000, notionalUsd: contracts(n) * 810, sourceTimestamp: t(n) };
  r.footprints.ingest([row], trade => r.coverage.trade(market.id, String(trade.tradeId), t(n), now));
  r.flows.ingest([row]);
}
/** The loop up to `to`: a pass every 250 ms with the feed live, the trades `first`..`last` taken at their time, after the pass. */
function feed(r: Recordings, clock: Clock, to: number, first: number, last: number, market = OKX): void {
  for (; clock.now < to; clock.now += 250) {
    r.coverage.pass(market.id, true, clock.now);
    for (let n = first; n <= last; n++) if (t(n) >= clock.now && t(n) < clock.now + 250) live(r, n, clock.now, market);
  }
}
/** OKX's trade history up to trade `last`, paged back 100 rows at a time. */
function okxHistory(last: number) {
  const calls: string[] = [];
  const fetch: HistoryFetch = async request => {
    calls.push(request.url);
    const url = new URL(request.url), after = url.searchParams.get('after'), top = after ? Number(after) - 1 : last, ids: number[] = [];
    assert.equal(url.hostname, 'www.okx.com');
    for (let n = top; n >= 0 && ids.length < 100; n--) ids.push(n);
    return { ok: true, status: 200, body: { code: '0', data: ids.map(n => ({ tradeId: String(n), px: '81000', sz: String(contracts(n)), side: n % 2 ? 'buy' : 'sell', ts: String(t(n)) })) } };
  };
  return { fetch, calls };
}
const usd = (r: Recordings, id = ID): number => Math.round(r.footprints.queryMany([id], T0, T0 + 10 * MINUTE, MINUTE, 1).bars.reduce((sum, b) => sum + b.buyUsd + b.sellUsd, 0));
const flowUsd = (r: Recordings, id = ID): number => { const f = r.flows.frame([id], T0, T0 + 10 * MINUTE).instruments[0]!; return Math.round([...f.buy, ...f.sell].reduce((a, b) => a + b, 0)); };
const openGaps = (r: Recordings, id = ID) => r.coverage.gaps(id, T0, r.coverage.openTo(id)!);
const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lmf-recovery-'));

test('the gap a restart left is filled from the venue\'s history once the feed is back, once, and stays filled after another restart', async () => {
  const dir = tempDir(), file = path.join(dir, 'depth-v2.sqlite'), ledger = path.join(dir, 'trade-recovery.json'), clock = { now: T0 };
  const history = okxHistory(2_000);
  const start = (r: Recordings) => new TradeRecovery({ recordings: r, file: ledger, fetch: history.fetch, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
  try {
    // The first run records trades 0..150 and stops; the next starts 25 s later and its feed is back at once, from trade 275.
    let r = recordings(file, clock);
    feed(r, clock, t(150) + 1, 0, 150);
    shut(r);
    clock.now = t(275) - 50;
    r = recordings(file, clock);
    let recovery = start(r);
    feed(r, clock, t(400) + 1, 275, 400);
    const [gap] = openGaps(r);
    assert.deepEqual([gap?.before?.id, gap?.after?.id], ['150', '275']);
    recovery.poll(clock.now); await recovery.running;
    assert.equal(history.calls.length, 2, 'two pages back from trade 275 reach trade 150');
    assert.deepEqual(openGaps(r), [], 'the gap is covered now');
    assert.deepEqual(r.coverage.covered(ID, T0, clock.now, 'recovered'), [[gap!.from, gap!.to]]);
    assert.equal(usd(r), once(400), 'the footprint holds every trade once');
    assert.equal(flowUsd(r), once(400), 'and so does the flow');
    const sizes = r.footprints.sizes([ID], [10]).windows[0]!;
    assert.equal(sizes.buyN + sizes.sellN, 124, 'the size statistics count the 124 recovered orders');
    assert.equal(sizes.sell[1], 40_500, 'the whale among them in its size box');
    assert.deepEqual(r.prints.query(T0, T0 + 10 * MINUTE).map(p => [p.t, p.usd]), [[t(200), 40_500]], 'a large order recovered is a print');
    assert.deepEqual(r.prints.takeFresh(), [], 'and never handed on as new: no bubble flashes, no sound');

    // Looked at again, nothing is left to ask for and nothing changes.
    clock.now += 61_000; recovery.poll(clock.now); await recovery.running;
    assert.equal(history.calls.length, 2);
    assert.equal(usd(r), once(400));

    // Another restart a minute later: the recovered stretch was stored with the minutes it filled, so only the new gap is asked for.
    recovery.close(); shut(r);
    clock.now = t(800) - 50;
    r = recordings(file, clock);
    recovery = start(r);
    feed(r, clock, t(850) + 1, 800, 850);
    recovery.poll(clock.now); await recovery.running;
    assert.equal(r.coverage.covered(ID, T0, clock.now, 'recovered').length, 2);
    assert.deepEqual(openGaps(r), []);
    assert.equal(usd(r), once(850), 'every trade once, across both restarts');
    assert.equal(flowUsd(r), once(850));
    recovery.close(); shut(r);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the gap a restart left is filled when the run before went on listening after its last trade', async () => {
  // The usual case: the last pass before the stop comes a little after the last trade, so the stretch ends after its seam, in a second
  // that holds the last trades before the gap. Seen live 2026-10-26: the gap of a restart was given up whole as recorded live.
  const dir = tempDir(), file = path.join(dir, 'depth-v2.sqlite'), clock = { now: T0 };
  const history = okxHistory(400);
  try {
    let r = recordings(file, clock);
    feed(r, clock, t(150) + 600, 0, 150);
    shut(r);
    clock.now = t(275) - 50;
    r = recordings(file, clock);
    const recovery = new TradeRecovery({ recordings: r, fetch: history.fetch, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
    feed(r, clock, t(400) + 1, 275, 400);
    recovery.poll(clock.now); await recovery.running;
    assert.deepEqual(openGaps(r), [], 'the restart\'s gap is covered');
    assert.equal(usd(r), once(400), 'with every trade of it, once');
    recovery.close(); shut(r);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trades the recording took inside a gap (a frozen loop\'s sockets handing on what they held) are not recovered a second time', async () => {
  const dir = tempDir(), file = path.join(dir, 'depth-v2.sqlite'), clock = { now: T0 };
  const history = okxHistory(600);
  try {
    let r = recordings(file, clock);
    feed(r, clock, t(50) + 1, 0, 50);
    // The loop freezes for 5 s; as it wakes the socket hands on trades 51..75, before the first pass: recorded, in no stretch.
    clock.now = t(75);
    for (let n = 51; n <= 75; n++) live(r, n, clock.now);
    feed(r, clock, t(100) + 1, 76, 100);
    shut(r);
    // After a restart their ids are not known any more: only the recording's own seconds say they are there.
    clock.now = t(150) - 50;
    r = recordings(file, clock);
    const recovery = new TradeRecovery({ recordings: r, fetch: history.fetch, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
    feed(r, clock, t(200) + 1, 150, 200);
    recovery.poll(clock.now); await recovery.running;
    // Past the minutes after the start, the older gaps are worked through.
    clock.now += 3 * MINUTE; recovery.poll(clock.now); await recovery.running;
    assert.equal(usd(r), once(200), 'trades 101..149 recovered, 51..75 counted once');
    assert.equal(flowUsd(r), once(200));
    assert.equal(openGaps(r).length, 1, 'the frozen seconds stay a gap the coverage shows');
    clock.now += 10 * MINUTE; const calls = history.calls.length; recovery.poll(clock.now); await recovery.running;
    assert.equal(history.calls.length, calls, 'and are not asked for again');
    recovery.close(); shut(r);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Binance USD-M, whose trades the feed manager names `<symbol>:<id>`, is read from the venue\'s id after the seam and counted once', async () => {
  const clock = { now: T0 }, r = recordings(null, clock), asked: string[] = [];
  const BINANCE: Market = { id: 'binance:BTCUSDT', name: n => `BTCUSDT:${n}` };
  // The venue's aggregate trades forward from an id (`m`: the buyer was the maker, so the taker sold).
  const fetch: HistoryFetch = async request => {
    asked.push(request.url);
    const from = Number(new URL(request.url).searchParams.get('fromId')), rows: unknown[] = [];
    for (let n = from; n <= 600 && rows.length < 1000; n++) rows.push({ a: n, p: '81000', q: String(contracts(n) * 0.01), T: t(n), m: n % 2 === 0 });
    return { ok: true, status: 200, body: rows };
  };
  const recovery = new TradeRecovery({ recordings: r, fetch, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
  feed(r, clock, t(50) + 1, 0, 50, BINANCE);
  // The feed is down for ten seconds, then back from trade 100.
  for (; clock.now < t(100) - 50; clock.now += 250) r.coverage.pass(BINANCE.id, false, clock.now);
  feed(r, clock, t(150) + 1, 100, 150, BINANCE);
  recovery.poll(clock.now); await recovery.running;
  assert.deepEqual(asked.map(url => new URL(url).searchParams.get('fromId')), ['51']);
  assert.deepEqual(openGaps(r, BINANCE.id), []);
  assert.equal(usd(r, BINANCE.id), once(150));
  assert.equal(flowUsd(r, BINANCE.id), once(150));
  recovery.close();
});

test('a gap older than the venue\'s history answers is never asked for (Binance USD-M: two days), and a newer one is filled', async () => {
  const DAY = 24 * 60 * MINUTE, clock = { now: T0 }, r = recordings(null, clock), asked: number[] = [];
  const BINANCE: Market = { id: 'binance:BTCUSDT', name: n => `BTCUSDT:${n}` };
  // Trade n three days before trade n + 1000: the old gap lies between trades 50 and 100, the new one between 1050 and 1100.
  const at = (n: number): number => n >= 1_000 ? t(n - 1_000) + 3 * DAY : t(n);
  const fetch: HistoryFetch = async request => {
    const from = Number(new URL(request.url).searchParams.get('fromId')), rows: unknown[] = [];
    asked.push(from);
    if (from < 1_000) return { ok: false, status: 400, body: { code: -4166, msg: 'Search window is restricted to recent 2 days only.' } };
    for (let n = from; n <= 1_150 && rows.length < 1000; n++) rows.push({ a: n, p: '81000', q: '0.01', T: at(n), m: n % 2 === 0 });
    return { ok: true, status: 200, body: rows };
  };
  const take = (n: number): void => { const row = { instrumentId: BINANCE.id, tradeId: BINANCE.name(n), side: n % 2 ? 'buy' : 'sell', price: 81_000, notionalUsd: 810, sourceTimestamp: at(n) }; r.footprints.ingest([row], trade => r.coverage.trade(BINANCE.id, String(trade.tradeId), at(n), clock.now)); r.flows.ingest([row]); };
  /** The loop over trades first..last at their time, the feed live or not. */
  const pass = (first: number, last: number, live: boolean): void => { for (const end = at(last) + 1; clock.now < end; clock.now += 250) { r.coverage.pass(BINANCE.id, live, clock.now); if (live) for (let n = first; n <= last; n++) if (at(n) >= clock.now && at(n) < clock.now + 250) take(n); } };
  const recovery = new TradeRecovery({ recordings: r, fetch, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
  pass(0, 50, true); pass(51, 99, false); pass(100, 150, true);
  clock.now = at(1_000) - 50;
  pass(1_000, 1_050, true); pass(1_051, 1_099, false); pass(1_100, 1_150, true);
  clock.now += 3 * MINUTE; recovery.poll(clock.now); await recovery.running;
  assert.deepEqual(asked, [1_051], 'only the newer gap is asked for');
  assert.equal(openGaps(r, BINANCE.id).length, 2, 'the old gap stays a gap, and so does the one between the two recordings');
  assert.equal(recovery.status().resting['binance-fapi'], undefined, 'and the venue\'s limit is not rested on it');
  recovery.close();
});

test('a gap a venue cannot fill is asked for once or a few times, never again, and not after a restart either', async () => {
  const dir = tempDir(), ledger = path.join(dir, 'trade-recovery.json'), clock = { now: T0 };
  const ids = ['deribit:BTC-PERPETUAL', 'bybit:BTCUSDT', 'coinbase:BTC-USD'];
  const r = recordings(null, clock), asked = { bybit: 0, coinbase: 0, other: 0 };
  // Bybit's newest page and Coinbase's pages hold only trades from after the gap (Coinbase's cursor reaching nowhere older).
  const fetch: HistoryFetch = async request => {
    const host = new URL(request.url).hostname;
    if (host === 'api.bybit.com') { asked.bybit++; return { ok: true, status: 200, body: { retCode: 0, result: { list: [{ execId: 'e1', price: '81000', size: '0.01', side: 'Buy', time: String(T0 + 29_000) }] } } }; }
    if (host === 'api.exchange.coinbase.com') { asked.coinbase++; return { ok: true, status: 200, body: [{ trade_id: 9_000, side: 'sell', size: '0.01', price: '81000', time: new Date(T0 + 29_000).toISOString() }] }; }
    asked.other++; throw new Error(`${host} has no history to read`);
  };
  const start = () => new TradeRecovery({ recordings: r, file: ledger, fetch, budget: { ...RECOVERY_BUDGET, pages: 4 }, now: () => clock.now, sleep: async ms => { clock.now += ms; }, log: () => {} });
  /** The server's loop for `minutes`, an action whenever one is due. */
  const run = async (recovery: TradeRecovery, minutes: number): Promise<void> => { for (const end = clock.now + minutes * MINUTE; clock.now < end; clock.now += 5_000) { recovery.poll(clock.now); await recovery.running; } };
  try {
    let recovery = start();
    // Each market recorded for 10 s, not for the next 10 (its feed reconnecting), then again.
    for (; clock.now < T0 + 30_000; clock.now += 250) for (const id of ids) r.coverage.pass(id, clock.now < T0 + 10_000 || clock.now >= T0 + 20_000, clock.now);
    clock.now = T0 + 3 * MINUTE;
    await run(recovery, 15);
    assert.deepEqual([asked.bybit, asked.other], [1, 0], 'Bybit\'s newest page is asked once, Deribit never');
    assert.ok(asked.coinbase > 0);
    const coinbase = asked.coinbase;
    await run(recovery, 30);
    assert.deepEqual([asked.bybit, asked.coinbase, asked.other], [1, coinbase, 0], 'nothing is asked again');
    const status = recovery.status();
    assert.deepEqual(status.noHistory, ['deribit:BTC-PERPETUAL']);
    assert.equal(status.givenUp.gaps, 2);
    assert.equal(status.backlog.gaps, 0);
    recovery.close();
    // What was given up is remembered across a restart.
    recovery = start();
    await run(recovery, 15);
    assert.deepEqual([asked.bybit, asked.coinbase, asked.other], [1, coinbase, 0]);
    recovery.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
