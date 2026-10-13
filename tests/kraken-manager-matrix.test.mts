import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, WHOLE_BOOK_EVERY_MS } from '../src/server/live-feeds.mts';
import {
  buildKrakenRequest,
  buildKrakenSubscription,
  createKrakenDepthSession,
  applyKrakenDepthSessionMessage,
  handOnKrakenDepthSession,
  krakenBookChecksum,
  normalizeKrakenAssetPairs,
  normalizeKrakenDepth,
  VENUE_TRANSPORT_POLICIES,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
  closeWith(reason = 'closed') { this.closed = true; this.onClose?.(reason); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/AssetPairs')) return { error: [], result: { XBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 5, status: 'online' } } };
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function levels() {
  return {
    bids: [{ price: '100.00', qty: '2.00000000' }, { price: '99.50', qty: '1.00000000' }],
    asks: [{ price: '101.00', qty: '3.00000000' }, { price: '101.50', qty: '1.00000000' }],
  };
}

function wideLevels() {
  return {
    bids: Array.from({ length: 11 }, (_, index) => ({ price: (100 - index * 0.5).toFixed(2), qty: '1.00000000' })),
    asks: Array.from({ length: 11 }, (_, index) => ({ price: (101 + index * 0.5).toFixed(2), qty: '1.00000000' })),
  };
}

function frame(type: string, current = levels(), symbol = 'XBT/USD') {
  return { channel: 'book', type, data: [{ symbol, ...current, checksum: krakenBookChecksum(current), timestamp: '2026-09-20T00:00:00.000000Z' }] };
}

function subscriptionAck(symbol = 'XBT/USD') {
  return { method: 'subscribe', result: { channel: 'book', symbol, depth: 1000, snapshot: true }, success: true };
}

test('Kraken descriptors, metadata, and the documented CRC32 example are exact', () => {
  assert.equal(buildKrakenRequest('assetPairs').url, 'https://api.kraken.com/0/public/AssetPairs');
  assert.match(buildKrakenRequest('depth', { symbol: 'XBT/USD', count: 100 }).url, /\/Depth\?pair=XBT%2FUSD&count=100$/);
  const subscription = buildKrakenSubscription('depth', { symbol: 'XBT/USD', depth: 100 });
  assert.deepEqual(subscription, { url: 'wss://ws.kraken.com/v2', method: 'subscribe', channel: 'book', symbol: 'BTC/USD', depth: 100, snapshot: true, args: ['BTC/USD'], topic: 'book:BTC/USD' });
  assert.equal(krakenBookChecksum({
    asks: [['45285.2', '0.00100000'], ['45286.4', '1.54571953'], ['45286.6', '1.54571109'], ['45289.6', '1.54560911'], ['45290.2', '0.15890660'], ['45291.8', '1.54553491'], ['45294.7', '0.04454749'], ['45296.1', '0.35380000'], ['45297.5', '0.09945542'], ['45299.5', '0.18772827']],
    bids: [['45283.5', '0.10000000'], ['45283.4', '1.54582015'], ['45282.1', '0.10000000'], ['45281.0', '0.10000000'], ['45280.3', '1.54592586'], ['45279.0', '0.07990000'], ['45277.6', '0.03310103'], ['45277.5', '0.30000000'], ['45277.3', '1.54602737'], ['45276.6', '0.15445238']],
  }), 3310070434);
  const metadata = normalizeKrakenAssetPairs({ error: [], result: { XBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 5, status: 'online' } } }, { receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.deepEqual(metadata.assets[0], { instrumentId: 'kraken:XBT/USD', venue: 'kraken', nativeSymbol: 'XBT/USD', symbol: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', marketType: 'spot', tickSize: 0.1, quantityUnit: 'base', isDelisted: false, status: 'online', lotSize: 0.00001, metadataSource: 'kraken-asset-pairs' });
});

test('Kraken session verifies snapshot/update CRC32, filters symbols, and fails closed on a mismatch', () => {
  const initial = frame('snapshot');
  const snapshot = normalizeKrakenDepth(initial, { symbol: 'XBT/USD' });
  const session = createKrakenDepthSession({ topic: 'book:XBT/USD', instrumentId: 'kraken:XBT/USD', sessionToken: 'kraken-depth:1', depth: 100 });
  const acceptedSnapshot = applyKrakenDepthSessionMessage(session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: snapshot });
  assert.equal(acceptedSnapshot.accepted, true);
  const next = levels(); next.bids[0] = { price: '100.00', qty: '4.00000000' }; next.asks[1] = { price: '101.50', qty: '0' };
  const normalizedUpdate = normalizeKrakenDepth(frame('update', next), { symbol: 'XBT/USD' });
  assert.equal(normalizedUpdate.continuity, 'checksum-pending');
  const acceptedUpdate = applyKrakenDepthSessionMessage(acceptedSnapshot.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: normalizedUpdate });
  assert.equal(acceptedUpdate.accepted, true);
  assert.equal(defined(acceptedUpdate.session.book).continuity, 'checksum-verified');
  assert.equal(defined(acceptedUpdate.session.book).bids[0].amount, 4);
  assert.equal(defined(acceptedUpdate.session.book).asks.some(row => row.price === 101.5), false);
  const malformed = normalizeKrakenDepth(frame('update', next), { symbol: 'XBT/USD' }); malformed.checksum += 1;
  const rejected = applyKrakenDepthSessionMessage(acceptedUpdate.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: malformed });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'resync-required');
  assert.equal(rejected.session.invalidated, true);
});

test('Kraken session prunes local books to the subscribed depth before checksum verification', () => {
  const initial = wideLevels();
  const snapshot = normalizeKrakenDepth(frame('snapshot', initial), { symbol: 'XBT/USD' });
  const session = createKrakenDepthSession({ topic: 'book:XBT/USD', instrumentId: 'kraken:XBT/USD', sessionToken: 'kraken-depth:depth-10', depth: 10 });
  const acceptedSnapshot = applyKrakenDepthSessionMessage(session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:depth-10', update: snapshot });
  assert.equal(acceptedSnapshot.accepted, true);
  assert.equal(acceptedSnapshot.session.bids.length, 10);
  assert.equal(acceptedSnapshot.session.asks.length, 10);
  const next = { bids: [{ price: '100.25', qty: '1.00000000' }], asks: [] };
  const nextBook = { bids: [{ price: '100.25', qty: '1.00000000' }, ...initial.bids], asks: initial.asks };
  const update = normalizeKrakenDepth({ channel: 'book', type: 'update', data: [{ symbol: 'XBT/USD', ...next, checksum: krakenBookChecksum(nextBook), timestamp: '2026-09-20T00:00:00.000000Z' }] }, { symbol: 'XBT/USD' });
  const acceptedUpdate = applyKrakenDepthSessionMessage(acceptedSnapshot.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:depth-10', update });
  assert.equal(acceptedUpdate.accepted, true);
  assert.equal(acceptedUpdate.session.bids.length, 10);
  assert.equal(acceptedUpdate.session.asks.length, 10);
  assert.equal(defined(acceptedUpdate.session.book).bids[0].price, 100.25);
});

test('Kraken manager requires matching ACK, routes checksum-verified data, and fences reconnects', async () => {
  const v2frame = (...args: Parameters<typeof frame>) => frame(args[0], args[1], args[2] ?? 'BTC/USD');
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  // Each update comes a hand-on interval after the last book, so every one is handed on.
  let clock = 1_000_000;
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, now: () => clock, schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {}, onMessage: message => messages.push(message) });
  const timers:{fn:()=>unknown;delay:number}[] = [];
  await manager.start({ selectedOrderbookVenues: ['kraken'], krakenEnabled: true, krakenSymbol: 'XBT/USD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'kraken-depth'));
  assert.equal(socket.spec.request.url, 'wss://ws.kraken.com/v2');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 1000, snapshot: true } });
  assert.equal(manager.status()['kraken-metadata'].state, 'snapshot');
  socket.emit({ method: 'subscribe', result: { channel: 'book', symbol: 'ETH/USD', depth: 1000, snapshot: true }, success: true });
  socket.emit(v2frame('snapshot', levels(), 'ETH/USD'));
  assert.equal(manager.status()['kraken-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'kraken-depth'), false);
  socket.emit({ method: 'subscribe', result: { channel: 'book', symbol: 'BTC/USD', depth: 1000, snapshot: false }, success: true });
  assert.equal(manager.status()['kraken-depth'].subscriptionAcked, false);
  socket.emit(subscriptionAck('BTC/USD'));
  socket.emit(v2frame('snapshot'));
  const updated = levels(); updated.bids[0] = { price: '100.00', qty: '4.00000000' };
  clock += WHOLE_BOOK_EVERY_MS;
  socket.emit(v2frame('update', updated));
  const depthMessages = messages.filter(item => item.id === 'kraken-depth');
  // The session delivers its whole book each time, so the update arrives as a snapshot: the runtime state merges a delta but replaces a snapshot.
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 2);
  assert.equal(defined(depthMessages.filter(item => item.message.kind === 'depthSnapshot').at(-1)).message.checksumVerified, true);
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthDelta').length, 0);
  assert.equal(manager.status()['kraken-depth'].state, 'live');
  const before = depthMessages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['kraken-depth'].state, 'backoff');
  socket.emit(v2frame('snapshot'));
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'kraken-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit(subscriptionAck('BTC/USD'));
  replacement.emit(v2frame('update', updated));
  assert.equal(messages.filter(item => item.id === 'kraken-depth').length, before + 1); // fresh snapshot is required
  replacement.emit(v2frame('snapshot'));
  clock += WHOLE_BOOK_EVERY_MS;
  replacement.emit(v2frame('update', updated));
  assert.equal(messages.filter(item => item.id === 'kraken-depth').length, before + 3);
  manager.stop();
});

test('Kraken session: in-place levels match a whole re-sort after every update, and a held update is handed on later as it would have been', () => {
  // A reference book kept the old way: every level in a map, sorted and cut to the depth after each update.
  const DEPTH = 40, ref = { bids: new Map<string, string>(), asks: new Map<string, string>() };
  const sorted = (side: 'bids' | 'asks') => [...ref[side].entries()].map(([price, qty]) => ({ price, qty }))
    .sort((a, b) => side === 'bids' ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price));
  const cut = () => { for (const side of ['bids', 'asks'] as const) for (const row of sorted(side).slice(DEPTH)) ref[side].delete(row.price); };
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 60; i++) { ref.bids.set((100 - i * 0.5).toFixed(1), (0.1 + rnd()).toFixed(8)); ref.asks.set((100.5 + i * 0.5).toFixed(1), (0.1 + rnd()).toFixed(8)); }
  cut();
  const wire = (type: string, rows: { bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] }) =>
    normalizeKrakenDepth({ channel: 'book', type, data: [{ symbol: 'XBT/USD', ...rows, checksum: krakenBookChecksum({ bids: sorted('bids'), asks: sorted('asks') }), timestamp: '2026-10-13T00:00:00.000000Z' }] }, { symbol: 'XBT/USD' });
  const options = { topic: 'book:XBT/USD', sessionToken: 't' };
  let session = applyKrakenDepthSessionMessage(createKrakenDepthSession({ ...options, instrumentId: 'kraken:XBT/USD', depth: DEPTH }), { ...options, update: wire('snapshot', { bids: sorted('bids'), asks: sorted('asks') }) }).session;
  const asBook = (side: 'bids' | 'asks') => sorted(side).map(row => ({ price: Number(row.price), amount: Number(row.qty) }));
  for (let k = 0; k < 400; k++) {
    const side = rnd() < 0.5 ? 'bids' : 'asks', changed: { price: string; qty: string }[] = [];
    for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) {
      // Inside the book, past its end (cut off again) or a removal of a level held.
      const offset = Math.floor(rnd() * 70) * 0.5, price = (side === 'bids' ? 100 - offset : 100.5 + offset).toFixed(1);
      if (rnd() < 0.3 && ref[side].has(price)) { ref[side].delete(price); changed.push({ price, qty: '0' }); }
      else { const qty = (0.01 + rnd()).toFixed(8); ref[side].set(price, qty); changed.push({ price, qty }); }
    }
    cut();
    const handOn = k % 5 === 4;
    const result = applyKrakenDepthSessionMessage(session, { ...options, update: wire('update', side === 'bids' ? { bids: changed, asks: [] } : { bids: [], asks: changed }), handOn });
    assert.equal(result.accepted, true, `update ${k}: ${result.reason}`);
    assert.equal(result.held === true, !handOn);
    session = result.session;
    assert.deepEqual(session.bids.map(row => row.price), sorted('bids').map(row => row.price), `update ${k}`);
    assert.deepEqual(session.asks.map(row => row.price), sorted('asks').map(row => row.price));
    if (handOn) { assert.deepEqual(defined(session.book).bids, asBook('bids')); assert.deepEqual(defined(session.book).asks, asBook('asks')); assert.equal(session.pending, null); }
  }
  // Held, then handed on without another update: the book is the levels as they stand, with the last update's own fields.
  ref.bids.set('100.0', '9.00000000'); cut();
  const last = wire('update', { bids: [{ price: '100.0', qty: '9.00000000' }], asks: [] });
  const held = applyKrakenDepthSessionMessage(session, { ...options, update: last, handOn: false });
  assert.equal(held.held, true);
  assert.notDeepEqual(defined(held.session.book).bids, asBook('bids'), 'the book handed on is behind until handed on again');
  const flushed = defined(handOnKrakenDepthSession(held.session));
  assert.deepEqual(defined(flushed.session.book).bids, asBook('bids'));
  assert.equal(defined(flushed.session.book).kind, 'depthSnapshot');
  assert.equal(defined(flushed.session.book).checksum, last.checksum);
  assert.equal(handOnKrakenDepthSession(flushed.session), null, 'nothing is held any more');
});

test('Kraken manager hands its book on at most every WHOLE_BOOK_EVERY_MS, and a held update goes out on a timer when nothing follows it', async () => {
  const v2frame = (...args: Parameters<typeof frame>) => frame(args[0], args[1], args[2] ?? 'BTC/USD');
  const fake = transport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number;cancelled?:boolean}[] = [];
  let clock = 5_000_000;
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, now: () => clock,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: timer => { (timer as { cancelled?: boolean }).cancelled = true; }, onMessage: message => messages.push(message) });
  await manager.start({ selectedOrderbookVenues: ['kraken'], krakenEnabled: true, krakenSymbol: 'XBT/USD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'kraken-depth'));
  socket.emit(subscriptionAck('BTC/USD'));
  const books = () => messages.filter(item => item.id === 'kraken-depth' && item.message.kind === 'depthSnapshot' && item.message.invalidated !== true);
  const step = (qty: string) => { const book = levels(); book.bids[0] = { price: '100.00', qty }; return book; };
  socket.emit(v2frame('snapshot'));
  assert.equal(books().length, 1, 'a snapshot is always handed on');
  clock += 10; socket.emit(v2frame('update', step('4.00000000')));
  clock += 10; socket.emit(v2frame('update', step('5.00000000')));
  assert.equal(books().length, 1, 'updates inside the interval are taken but not handed on');
  const flush = defined(timers.find(timer => timer.delay === WHOLE_BOOK_EVERY_MS - 10));
  clock += WHOLE_BOOK_EVERY_MS; socket.emit(v2frame('update', step('6.00000000')));
  assert.equal(books().length, 2);
  assert.equal(defined(defined(books().at(-1)).message.bids?.[0]).amount, 6, 'the book handed on holds every update before it');
  // An update held right after that book, then the timer set before it runs late: the interval counts from the book, so it waits again.
  clock += 20; socket.emit(v2frame('update', step('7.00000000')));
  await flush.fn();
  assert.equal(books().length, 2, 'a late timer does not hand a book on 20 ms after the last');
  const rest = defined(timers.at(-1));
  assert.equal(rest.delay, WHOLE_BOOK_EVERY_MS - 20, 'it waits out the rest of the interval');
  clock += WHOLE_BOOK_EVERY_MS; await rest.fn();
  assert.equal(books().length, 3, 'the held update goes out on the timer');
  assert.equal(defined(defined(books().at(-1)).message.bids?.[0]).amount, 7);
  assert.equal(defined(books().at(-1)).message.checksumVerified, true);
  clock += 20; socket.emit(v2frame('update', step('8.00000000')));
  const pending = defined(timers.at(-1));
  socket.closeWith('lost');
  assert.equal(pending.cancelled, true, 'a closed feed cancels its timer');
  await pending.fn();
  assert.equal(books().length, 3, 'and a timer firing anyway hands nothing on');
  manager.stop();
});
