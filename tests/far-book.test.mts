import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { FAR_EVERY_MS, FAR_STALE_MS, FarPoller, beyond, farSource, freshFar, pageShown, setPageShown, type FarSource } from '../src/shared/far-book.ts';
import { OkxConnector, OkxSpotConnector, BinancePerpConnector } from '../src/shared/venues.ts';
import { valueBook, withFar } from '../src/server/v2/levels.mts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { decodeLevels } from '../src/app/wire.ts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import type { BrowserVenue } from '../src/shared/venues.ts';

/** OKX's `books-full` answer as it comes (four fields a row: price, size, a deprecated 0, the order count). */
const okxBody = (bids: [number, number][], asks: [number, number][], code = '0') =>
  ({ code, msg: '', data: [{ bids: bids.map(([p, s]) => [String(p), String(s), '0', '3']), asks: asks.map(([p, s]) => [String(p), String(s), '0', '2']), ts: '1760300000000' }] });
const answer = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

test('far book: where each venue\'s deep REST book is read, for any coin, and the shapes it comes in', () => {
  assert.equal(farSource('okx:ETH-USDT-SWAP')?.url, 'https://www.okx.com/api/v5/market/books-full?instId=ETH-USDT-SWAP&sz=5000');
  assert.equal(farSource('okxspot:BTC-USDT')?.url, 'https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000');
  assert.equal(farSource('aster:SOLUSDT')?.url, 'https://fapi.asterdex.com/fapi/v1/depth?symbol=SOLUSDT&limit=1000');
  assert.equal(farSource('binance:BTCUSDT'), null, 'a venue whose WebSocket reaches far enough has none');
  assert.equal(farSource('okx'), null);
  // OKX: four fields a row, two taken; best first whatever order they came in; an error code is no book.
  const okx = farSource('okx:BTC-USDT-SWAP')!;
  assert.deepEqual(okx.parse(okxBody([[99, 2], [100, 1]], [[101, 3]])), { bids: [[100, 1], [99, 2]], asks: [[101, 3]] });
  assert.equal(okx.parse(okxBody([[100, 1]], [[101, 1]], '51001')), null);
  assert.equal(okx.parse({ code: '0', data: [] }), null);
  // Aster: Binance's shape; a zero or unreadable row is left out.
  const aster = farSource('aster:BTCUSDT')!;
  assert.deepEqual(aster.parse({ lastUpdateId: 1, bids: [['100', '1'], ['99', '0'], ['x', '1']], asks: [['101', '2']] }), { bids: [[100, 1]], asks: [[101, 2]] });
  assert.equal(aster.parse({ code: -1121, msg: 'Invalid symbol.' }), null);
});

test('far book: only the levels strictly past the WebSocket book\'s deepest one, and only while fresh', () => {
  const bids: [number, number][] = [[100, 1], [99, 1], [98, 1]], asks: [number, number][] = [[101, 1], [102, 1], [103, 1]];
  assert.deepEqual(beyond(bids, 99, 'bid'), [[98, 1]]);
  assert.deepEqual(beyond(asks, 102, 'ask'), [[103, 1]]);
  assert.deepEqual(beyond(bids, NaN, 'bid'), [], 'no WebSocket level on that side: none');
  const far = { bids, asks, at: 1_000 };
  assert.equal(freshFar(far, 1_000 + FAR_STALE_MS), far);
  assert.equal(freshFar(far, 1_001 + FAR_STALE_MS), null);
});

test('far book reader: reads only while wanted, keeps the last book through a failure, and a stop drops a read in flight', async () => {
  const source: FarSource = { url: 'https://example.invalid/depth', parse: body => (body as { bids: [number, number][]; asks: [number, number][] } | null) };
  let wanted = false, now = 5_000, fresh = 0;
  const asked: string[] = [];
  let reply: () => Promise<{ ok: boolean; json(): Promise<unknown> }> = () => answer({ bids: [[1, 1]], asks: [[2, 1]] });
  const poller = new FarPoller(source, () => wanted, () => { fresh++; }, url => { asked.push(url); return reply(); }, () => now);
  poller.start();
  try {
    await poller.poll();
    assert.deepEqual(asked, [], 'not wanted (the book is not live, the page is hidden): nothing is read');
    wanted = true;
    await poller.poll();
    assert.deepEqual([asked.length, fresh, poller.latest?.at], [1, 1, 5_000]);
    // A failed read and a bad answer keep the last book.
    now = 5_000 + FAR_EVERY_MS;
    reply = () => Promise.reject(new Error('offline'));
    await poller.poll();
    reply = () => answer({}, false);
    await poller.poll();
    assert.deepEqual([fresh, poller.latest?.at], [1, 5_000]);
    // A read still in flight when the reader is stopped and started again is not kept.
    let release!: () => void;
    reply = () => new Promise(resolve => { release = () => resolve({ ok: true, json: () => Promise.resolve({ bids: [[9, 9]], asks: [[10, 9]] }) }); });
    const inFlight = poller.poll();
    poller.stop(); poller.start();
    release(); await inFlight;
    assert.equal(poller.latest, null);
    assert.equal(fresh, 1);
  } finally { poller.stop(); }
});

test('far book reader: a read that never settles is given up after its deadline, and the next one is still made', async () => {
  const source: FarSource = { url: 'https://example.invalid/depth', parse: body => (body as { bids: [number, number][]; asks: [number, number][] } | null) };
  let asked = 0, hang = true;
  // The headers come, the body never does, and the abort is not heard (the live server lost its far books to such a read for good).
  const poller = new FarPoller(source, () => true, () => {}, () => { asked++; return hang ? Promise.resolve({ ok: true, json: () => new Promise<unknown>(() => {}) }) : answer({ bids: [[1, 1]], asks: [[2, 1]] }); }, () => 7_000, 20);
  poller.start();
  try {
    const started = Date.now();
    await poller.poll();
    assert.ok(Date.now() - started < 5_000, 'the read was given up');
    assert.equal(poller.latest, null);
    hang = false;
    await poller.poll();
    assert.deepEqual([asked, (poller.latest as { at: number } | null)?.at], [2, 7_000], 'a second read was made and kept');
    assert.equal(poller.idleMs(7_500), 500, 'it ticked when the read ended');
  } finally { poller.stop(); }
});

test('far book reader: a failing exchange still ticks (never replaced for it), and a stop ends a read in flight at once', async () => {
  const source: FarSource = { url: 'https://example.invalid/depth', parse: body => (body as { bids: [number, number][]; asks: [number, number][] } | null) };
  let now = 1_000, aborted = false;
  const poller = new FarPoller(source, () => true, () => {}, (_url, init) => {
    if (now < 2_000) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  }, () => now, 60_000);
  poller.start();
  try {
    now = 1_500; await poller.poll();
    assert.equal(poller.idleMs(1_600), 100, 'a failed read is still a tick');
    now = 2_500;
    const started = Date.now(), inFlight = poller.poll();
    poller.stop();
    await inFlight;
    assert.ok(Date.now() - started < 1_000, 'the read ended with the stop, not at its 61 s give-up');
    assert.ok(aborted, 'its request was aborted');
  } finally { poller.stop(); }
});

/** A socket that never opens: the connector's book is fed by hand. */
class QuietSocket { binaryType = ''; onopen: unknown = null; onmessage: unknown = null; onerror: unknown = null; onclose: unknown = null; constructor(_url: string) {} send() {} close() {} }

test('OKX connector: the books-full levels are drawn past the 400 the WebSocket sends, never inside them, and leave when they age out', async () => {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch;
  const asked: string[] = [];
  let body: unknown = okxBody([[99.5, 50], [99, 7], [90, 4]], [[100.5, 50], [101, 8], [110, 5]]);
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.fetch = ((url: string) => { asked.push(String(url)); return answer(body); }) as unknown as typeof fetch;
  const spot = new OkxSpotConnector();
  try {
    assert.equal(new BinancePerpConnector().far, null);
    spot.start();
    const reader = spot.far!;
    assert.ok(reader, 'OKX books have a far book reader');
    await reader.poll();
    assert.deepEqual(asked, [], 'nothing is read before the book is live');
    spot.onMessage(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT' }, action: 'snapshot', data: [{ bids: [['100', '1', '0', '1'], ['99.5', '2', '0', '1']], asks: [['100.5', '1', '0', '1'], ['101', '2', '0', '1']], seqId: 10, prevSeqId: -1 }] }));
    const before = spot.valued(Date.now())!;
    assert.deepEqual([...before.bids.lo], [100, 99.5]);
    await reader.poll();
    assert.deepEqual(asked, ['https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000']);
    const after = spot.valued(Date.now())!;
    // 99.5 and 100.5 are inside the WebSocket book: its own sizes stand. 99 and 90, 101 is the WebSocket's own, 110 beyond it.
    assert.deepEqual([...after.bids.lo], [100, 99.5, 99, 90]);
    assert.deepEqual([...after.bids.usd], [100, 199, 693, 360]);
    assert.deepEqual([...after.asks.lo], [100.5, 101, 110]);
    assert.deepEqual([...after.asks.usd], [100.5, 202, 550]);
    // Once the far book is older than the window it is left off, with no new frame needed.
    assert.deepEqual([...spot.valued(Date.now() + FAR_STALE_MS + 1_000)?.bids.lo ?? []], [], 'the book itself went stale too');
    reader.latest = { ...reader.latest!, at: Date.now() - FAR_STALE_MS - 1 };
    assert.deepEqual([...spot.valued(Date.now())!.bids.lo], [100, 99.5]);
    // The swap reads its own instrument, sized in contracts like its WebSocket book.
    assert.equal(farSource(new OkxConnector().instrumentId)?.url, 'https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT-SWAP&sz=5000');
    spot.stop();
    assert.equal(reader.latest, null, 'a stop drops the far book');
  } finally { spot.stop(); globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; body = null; }
});

test('server: a feed book takes its far levels past its own deepest one, keeping its stamps and units', () => {
  const now = Date.now();
  const book = { bids: [[100, 1], [99.5, 2]], asks: [[100.5, 1], [101, 2]], units: 'base', market: { venue: 'aster', quote: 'USDT' }, sourceTimestamp: now, complete: true };
  const far = { bids: [[99.5, 50], [99, 7]] as [number, number][], asks: [[101, 50], [110, 5]] as [number, number][], at: now };
  const merged = withFar(book, far);
  assert.deepEqual(merged.bids, [[100, 1], [99.5, 2], [99, 7]]);
  assert.deepEqual(merged.asks, [[100.5, 1], [101, 2], [110, 5]]);
  assert.deepEqual([merged.units, merged.sourceTimestamp, merged.complete], ['base', now, true]);
  const value = valueBook('aster:BTCUSDT', merged, { venue: 'aster' }, now)!;
  assert.deepEqual([...value.bids.lo], [100, 99.5, 99]);
  // A grouped book or one with an empty side takes none.
  assert.equal(withFar({ ...book, sourceGrouping: 10 }, far).bids.length, 2);
  assert.equal(withFar({ ...book, asks: [] }, far).bids.length, 2);
});

test('server: OKX and Aster books on the feed manager are drawn with their far levels once read', async () => {
  const realFetch = globalThis.fetch, asked: string[] = [];
  globalThis.fetch = ((url: string) => { asked.push(String(url)); return answer({ bids: [['99', '7'], ['90', '4']], asks: [['110', '5']] }); }) as unknown as typeof fetch;
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20, heartbeatMs: 1_000 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const id = 'aster:BTCUSDT';
  (app.state.books as Record<string, unknown>)[id] = { venue: 'aster', bids: [[100, 1], [99.5, 2]], asks: [[100.5, 1], [101, 2]], units: 'base', market: { venue: 'aster', quote: 'USDT' }, sourceTimestamp: Date.now(), complete: true };
  const reaches: number[] = [];
  const socket = new WsClient(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    if (!Buffer.isBuffer(data)) return;
    try {
      const frame = decodeLevels(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      const book = frame.books.find(b => b.id === id);
      if (book) reaches.push(book.bids.lo[book.bids.lo.length - 1]!);
    } catch { /* another frame type */ }
  });
  try {
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (reaches.at(-1) === 90) { clearInterval(timer); resolve(); } }, 25); setTimeout(() => { clearInterval(timer); resolve(); }, 6_000); });
    assert.equal(reaches[0], 99.5, 'the WebSocket book alone at first');
    assert.equal(reaches.at(-1), 90, 'then reaching the far book\'s deepest bid');
    // Read once for the Aster book (the fixture's OKX swap book has its own reader; the trade-only connectors read none: see below).
    assert.equal(asked.filter(url => url.includes('asterdex')).length, 1);
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
    globalThis.fetch = realFetch;
  }
});

test('server: a connector run for its trades alone reads no far book (its book is not drawn)', async () => {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch, asked: string[] = [];
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.fetch = ((url: string) => { asked.push(String(url)); return answer(okxBody([[1, 1]], [[2, 1]])); }) as unknown as typeof fetch;
  const swap = new OkxConnector();
  const sources = new FlowSources(() => {}, Date.now, [{ id: 'okx', make: () => ({ book: swap, feeds: [] }) } as unknown as BrowserVenue]);
  try {
    sources.sync(new Set([swap.instrumentId]));
    assert.equal(swap.state, 'connecting', 'started for its trades');
    swap.onMessage(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ bids: [['100', '1']], asks: [['101', '1']], seqId: 1, prevSeqId: -1 }] }));
    assert.equal(swap.state, 'live');
    await swap.far!.poll();
    assert.deepEqual(asked, []);
  } finally { sources.close(); globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; }
});

test('far book: with no document (the feeds worker) the page says whether it is shown, and a hidden page reads none', async () => {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch, asked: string[] = [];
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.fetch = ((url: string) => { asked.push(String(url)); return answer(okxBody([[1, 1]], [[2, 1]])); }) as unknown as typeof fetch;
  const spot = new OkxSpotConnector();
  try {
    assert.equal(pageShown(), true);
    spot.start();
    spot.onMessage(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT' }, action: 'snapshot', data: [{ bids: [['100', '1']], asks: [['101', '1']], seqId: 1, prevSeqId: -1 }] }));
    setPageShown(false);
    await spot.far!.poll();
    assert.deepEqual(asked, []);
    setPageShown(true);
    await spot.far!.poll();
    assert.equal(asked.length, 1);
  } finally { setPageShown(true); spot.stop(); globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; }
});
