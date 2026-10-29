import { defined, fields, textValue } from './server-test-helpers.mts';
import type { LiveFeedEvent, LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_WATCH_MS, LiveFeedManager } from '../src/server/live-feeds.mts';
import { VENUE_TRANSPORT_POLICIES } from '../src/adapters/index.mts';

// An order book that stops being usable while its feed looks connected must come back without a restart. Coinbase's book stayed away
// 9.3 hours after a network outage (2026-10-20) while its trades and every other book recorded, and nothing said so.

class FakeSocket {
  declare spec: LiveFeedTransportOptions; declare sent: string[]; declare closed: boolean;
  declare onMessage: ((raw: unknown) => void) | undefined; declare onClose: ((reason: unknown) => void) | undefined; declare onError: ((error: unknown) => void) | undefined;
  constructor(spec: LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; }
  async open() { /* connects at once */ }
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onMessage?.(value); }
}

interface Timer { fn: () => unknown; delay: number }

const MARKETS = { coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD', deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL', selectedOrderbookVenues: ['coinbase', 'deribit'] };
const cbAck = { type: 'subscriptions', channels: [{ name: 'level2_50', product_ids: ['BTC-USD'] }, { name: 'heartbeat', product_ids: ['BTC-USD'] }] };
const cbSnapshot = (bid = '100') => ({ type: 'snapshot', product_id: 'BTC-USD', bids: [[bid, '2']], asks: [['101', '3']] });
const cbUpdate = (size: string) => ({ type: 'l2update', product_id: 'BTC-USD', time: '2026-10-26T00:00:01.000Z', changes: [['buy', '100', size]] });
const drAck = { jsonrpc: '2.0', id: 1, result: ['book.BTC-PERPETUAL.100ms'] };
const drBook = (data: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.100ms', data: { instrument_name: 'BTC-PERPETUAL', timestamp: 1_700_000_000_000, bids: [], asks: [], ...data } } });

/** A manager on a clock the test moves, with its reconnect timers held for the test to run and no heartbeat timer of its own. */
function rig({ idleMs = 0, onBeat }: { idleMs?: number; onBeat?: (fn: () => unknown) => void } = {}) {
  let clock = 1_800_000_000_000;
  const sockets: FakeSocket[] = [], timers: Timer[] = [], logs: string[] = [], messages: LiveFeedEvent[] = [];
  const policies = Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: async spec => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; },
    oiPollMs: 0, reconnectBaseMs: 1_000, transportIdleMs: idleMs, transportPolicies: policies,
    now: () => clock, transportNow: () => clock,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancel: timer => { const at = timers.indexOf(timer as Timer); if (at >= 0) timers.splice(at, 1); },
    heartbeatSchedule: fn => { onBeat?.(fn); return null; }, heartbeatCancel: () => {},
    log: line => logs.push(line), onMessage: event => { messages.push(event); },
  });
  const socketOf = (id: string) => defined(sockets.filter(socket => socket.spec.id === id).at(-1), id);
  /** Run the reconnect that is waiting (the newest timer): it opens the feed's new socket. */
  const reconnect = async () => { const timer = defined(timers.pop(), 'a scheduled reconnect'); await timer.fn(); };
  return { manager, sockets, timers, logs, messages, socketOf, reconnect, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const books = (manager: LiveFeedManager) => fields(manager.startDiagnostics().books);

test('a depth feed that stays connected but stops handing on its book is reconnected alone, and the diagnostics and the log say so', async () => {
  const { manager, logs, messages, socketOf, reconnect, advance } = rig();
  await manager.start(MARKETS);
  const coinbase = socketOf('coinbase-depth'), deribit = socketOf('deribit-depth');
  coinbase.emit(cbAck); coinbase.emit(cbSnapshot());
  deribit.emit(drAck); deribit.emit(drBook({ type: 'snapshot', change_id: 1, bids: [['new', 77_000, 10]], asks: [['new', 77_001, 10]] }));

  // Coinbase goes silent (as its socket did in the outage); Deribit keeps changing.
  advance(BOOK_WATCH_MS / 2); deribit.emit(drBook({ type: 'change', change_id: 2, prev_change_id: 1, bids: [['change', 77_000, 11]] }));
  manager.checkLiveness();
  assert.equal(coinbase.closed, false, 'thirty quiet seconds are not yet a lost book');
  advance(BOOK_WATCH_MS / 2 + 1_000); deribit.emit(drBook({ type: 'change', change_id: 3, prev_change_id: 2, bids: [['change', 77_000, 12]] }));
  manager.checkLiveness();

  assert.equal(coinbase.closed, true, 'the silent feed is dropped');
  assert.equal(manager.status()['coinbase-depth'].state, 'backoff');
  assert.match(textValue(manager.status()['coinbase-depth'].lastError), /no usable book for 61 s/);
  assert.ok(messages.some(event => event.id === 'coinbase-depth' && event.message.kind === 'depthSnapshot' && event.message.invalidated === true), 'its stale book is withdrawn');
  assert.equal(deribit.closed, false, 'the book that kept coming is left alone');
  assert.equal(manager.feeds.get('deribit-depth')?.socket, deribit);
  assert.equal(books(manager).reconnects, 1);
  assert.equal(fields(books(manager).last).id, 'coinbase-depth');
  assert.equal(logs.filter(line => /coinbase-depth: no usable book/.test(line)).length, 1, logs.join(' | '));

  await reconnect();
  const second = socketOf('coinbase-depth');
  assert.notStrictEqual(second, coinbase);
  second.emit(cbAck); second.emit(cbSnapshot('99'));
  assert.equal(manager.status()['coinbase-depth'].state, 'live', 'the book is back without a restart');
  assert.equal(fields(books(manager).ageMs)['coinbase-depth'], 0);
  manager.stop();
});

test('a reconnect that brings no lasting book makes the next one wait twice as long, and a book that keeps coming starts over', async () => {
  const { manager, logs, socketOf, reconnect, advance } = rig();
  await manager.start(MARKETS);
  const deribit = socketOf('deribit-depth');
  deribit.emit(drAck); deribit.emit(drBook({ type: 'snapshot', change_id: 1, bids: [['new', 77_000, 10]], asks: [['new', 77_001, 10]] }));
  let change = 1;
  const keepDeribit = () => { deribit.emit(drBook({ type: 'change', change_id: change + 1, prev_change_id: change, bids: [['change', 77_000, 10 + change]] })); change++; };
  // Coinbase never sends its snapshot: the first reconnect comes a minute after the feed opened.
  advance(BOOK_WATCH_MS + 1_000); keepDeribit(); manager.checkLiveness();
  assert.equal(socketOf('coinbase-depth').closed, true);
  await reconnect();

  // The new socket gives a snapshot and then nothing again.
  const second = socketOf('coinbase-depth');
  second.emit(cbAck); second.emit(cbSnapshot());
  advance(BOOK_WATCH_MS + 1_000); keepDeribit(); manager.checkLiveness();
  assert.equal(second.closed, false, 'the second reconnect waits two minutes, not one');
  assert.equal(fields(fields(books(manager).backoff)['coinbase-depth']).attempts, 1);
  advance(BOOK_WATCH_MS); keepDeribit(); manager.checkLiveness();
  assert.equal(second.closed, true);
  assert.equal(books(manager).reconnects, 2);
  assert.equal(logs.filter(line => /coinbase-depth/.test(line)).length, 1, 'a second reconnect within ten minutes is not logged again');
  await reconnect();

  // This time the book keeps coming for longer than the threshold: the backoff is forgotten.
  const third = socketOf('coinbase-depth');
  third.emit(cbAck); third.emit(cbSnapshot());
  for (let i = 0; i < 3; i++) { advance(BOOK_WATCH_MS / 2); keepDeribit(); third.emit(cbUpdate(String(3 + i))); manager.checkLiveness(); }
  assert.equal(third.closed, false);
  assert.deepEqual(books(manager).backoff, {});
  manager.stop();
});

test('a book whose feed was retired as idle is opened again', async () => {
  const beats: (() => unknown)[] = [];
  const { manager, socketOf, reconnect, advance } = rig({ idleMs: BOOK_WATCH_MS, onBeat: fn => beats.push(fn) });
  await manager.start(MARKETS);
  const coinbase = socketOf('coinbase-depth'), deribit = socketOf('deribit-depth');
  coinbase.emit(cbAck); coinbase.emit(cbSnapshot());
  deribit.emit(drAck); deribit.emit(drBook({ type: 'snapshot', change_id: 1, bids: [['new', 77_000, 10]], asks: [['new', 77_001, 10]] }));
  advance(BOOK_WATCH_MS + 1_000); deribit.emit(drBook({ type: 'change', change_id: 2, prev_change_id: 1, bids: [['change', 77_000, 11]] }));
  // The heartbeat round finds Coinbase silent past the idle limit and retires it: before the book watch nothing opened it again.
  for (const beat of beats.splice(0)) await beat();
  assert.equal(manager.feeds.has('coinbase-depth'), false);
  assert.equal(manager.status()['coinbase-depth'].state, 'stopped');

  manager.checkLiveness();
  await reconnect();
  assert.notStrictEqual(socketOf('coinbase-depth'), coinbase, 'a new socket is opened for the book');
  assert.equal(manager.feeds.has('coinbase-depth'), true);
  assert.equal(fields(books(manager).last).id, 'coinbase-depth');
  manager.stop();
});
