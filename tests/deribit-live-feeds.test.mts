import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
}
function transport() { const sockets:FakeSocket[] = []; return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } }; }

test('Deribit\'s whole book subscribes through JSON-RPC, routes its USD-denominated snapshot and the changes chained on it, and gives the book up at a gap', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: item => messages.push(item),
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('get_instrument') ? { result: { instrument_name: 'BTC-PERPETUAL', base_currency: 'BTC', counter_currency: 'USD', future_type: 'reversed', tick_size: 0.5, min_trade_amount: 10, settlement_currency: 'BTC', is_active: true } } : { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] } },
  });
  await manager.start({ deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const socket = fake.sockets.find(item => item.spec.venue === 'deribit');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(socket.sent[0]), { jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['book.BTC-PERPETUAL.100ms'] } });
  socket.emit({ jsonrpc: '2.0', id: 1, result: ['book.BTC-PERPETUAL.100ms'] });
  socket.emit({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.100ms', data: { type: 'snapshot', instrument_name: 'BTC-PERPETUAL', timestamp: 1_700_000_000_000, change_id: 42, bids: [[77_000, 125_000]], asks: [[77_001, 80_000]] } } });
  assert.equal(manager.status()['deribit-depth'].state, 'live');
  const message = defined(messages.find(item => item.venue === 'deribit' && item.message?.kind === 'depthSnapshot'));
  assert.equal(message.message.units, 'quote'); assert.equal(message.message.sequence, 42);
  assert.equal(message.message.resolution, 'native'); assert.equal(message.message.resolutionKey, 'native'); assert.equal(message.message.sourceGrouping, undefined); assert.equal(message.message.sourceDepth, undefined);
  assert.equal(defined(message.message.bids)[0].amount, 125_000);
  // A change chained on the snapshot: a new bid, the best ask changed, the old bid gone.
  const change = (changeId: number, previous: number, bids: unknown[], asks: unknown[]) => ({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.100ms', data: { type: 'change', instrument_name: 'BTC-PERPETUAL', timestamp: 1_700_000_000_000 + changeId, change_id: changeId, prev_change_id: previous, bids, asks } } });
  socket.emit(change(43, 42, [['new', 76_999.5, 50_000], ['delete', 77_000, 0]], [['change', 77_001, 90_000]]));
  const delta = defined(messages.filter(item => item.venue === 'deribit' && item.message?.kind === 'depthDelta').at(-1));
  assert.deepEqual([delta.message.sequence, delta.message.previousSequence], [43, 42]);
  assert.deepEqual(defined(delta.message.bids).map(row => [row.price, row.amount]), [[76_999.5, 50_000], [77_000, 0]]);
  assert.deepEqual(defined(delta.message.asks).map(row => [row.price, row.amount]), [[77_001, 90_000]]);
  assert.equal(manager.status()['deribit-depth'].state, 'live');
  // One that says it follows 45 when 43 was the last: a gap, and the book is not taken as whole any more.
  socket.emit(change(46, 45, [['new', 76_990, 10_000]], []));
  assert.notEqual(manager.status()['deribit-depth'].state, 'live');
  manager.stop();
});

test('Deribit subscription errors retire the public session and schedule recovery', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {} });
  await manager.start({ deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'deribit'));
  socket.emit({ jsonrpc: '2.0', id: 1, error: { code: 100, message: 'denied' } });
  assert.equal(manager.status()['deribit-depth'].state, 'backoff');
  assert.equal(socket.closed, true); assert.equal(timers.length, 1);
  manager.stop();
});
