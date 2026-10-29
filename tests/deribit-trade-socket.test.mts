import test from 'node:test';
import assert from 'node:assert/strict';
import { DeribitConnector } from '../src/shared/venues.ts';
import type { TradeEvent } from '../src/shared/connector.ts';

// The server's Deribit trades come from this connector (FlowSources), and they were not covered for 3 to 4 s every 600 to 603 s: Deribit
// closes a socket that has sent it nothing for ten minutes, and the connector only listened once subscribed (measured 2026-10-26).

/** A socket that behaves as Deribit's does: it answers `public/test` and closes once ten minutes pass without a frame from the client. */
class DeribitSocket {
  static made: DeribitSocket[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  readonly sent: { id?: unknown; method?: unknown }[] = [];
  closed = false;
  #idle: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly url: string) { DeribitSocket.made.push(this); setTimeout(() => { this.#arm(); this.onopen?.(); }, 1); }
  send(text: string) {
    const frame = JSON.parse(text) as { id?: unknown; method?: unknown };
    this.sent.push(frame); this.#arm();
    if (frame.method === 'public/test') setTimeout(() => this.push({ jsonrpc: '2.0', id: frame.id, result: { version: '1.2.26' } }), 1);
  }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.#idle); this.onclose?.(); }
  push(frame: unknown) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) }); }
  #arm() { clearTimeout(this.#idle); this.#idle = setTimeout(() => this.close(), 600_000); }
}

const subscription = (channel: string, data: unknown) => ({ jsonrpc: '2.0', method: 'subscription', params: { channel, data } });

test('Deribit never sees the trade socket idle for the ten minutes after which it closes one', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_790_000_000_000 });
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = DeribitSocket as unknown as typeof WebSocket;
  DeribitSocket.made = [];
  const deribit = new DeribitConnector(), trades: TradeEvent[] = [];
  // As FlowSources runs it: for its trades, its book not read.
  deribit.bookRead = false; deribit.onTrade = trade => trades.push(trade);
  try {
    deribit.start();
    t.mock.timers.tick(1);
    const socket = DeribitSocket.made[0]!;
    let change = 1;
    socket.push(subscription('book.BTC-PERPETUAL.100ms', { type: 'snapshot', instrument_name: 'BTC-PERPETUAL', change_id: change, bids: [['new', 99_990, 10_000]], asks: [['new', 100_010, 10_000]] }));
    // Half an hour of market: a book change and a trade every five seconds, and from this side only what the connector sends itself.
    for (let s = 5; s <= 1_800; s += 5) {
      t.mock.timers.tick(5_000);
      socket.push(subscription('book.BTC-PERPETUAL.100ms', { type: 'change', instrument_name: 'BTC-PERPETUAL', change_id: change + 1, prev_change_id: change, bids: [['change', 99_990, 10_000 + s]], asks: [] }));
      change++;
      socket.push(subscription('trades.BTC-PERPETUAL.100ms', [{ trade_id: String(s), price: 100_000, amount: 10, timestamp: Date.now(), direction: 'buy' }]));
    }
    assert.equal(DeribitSocket.made.length, 1, 'one connection for the whole half hour');
    assert.equal(socket.closed, false);
    assert.equal(deribit.state, 'live');
    assert.equal(trades.length, 360, 'every trade arrived, and the answers to the keepalive were not taken for any');
  } finally { deribit.stop(); globalThis.WebSocket = realSocket; }
});
