import test from 'node:test';
import assert from 'node:assert/strict';
import { averageCandles, withLive } from '../src/app/swing/average.ts';
import { SwingBook, swingTargets, type SwingReader } from '../src/app/swing/book.ts';
import type { SwingCandle } from '../src/app/swing/model.ts';
import { BTC } from '../src/shared/coins.ts';
import type { AppState } from '../src/app/store.ts';

const H = 3_600_000;
const k = (t: number, o: number, h: number, l: number, c: number): SwingCandle => ({ t, o, h, l, c });

test('the average takes each candle\'s open, high, low and close over the venues that have it, and only where half of them do', () => {
  const a = [k(0, 100, 104, 98, 102), k(H, 102, 106, 101, 105), k(2 * H, 105, 107, 103, 104)];
  const b = [k(0, 102, 106, 100, 104), k(H, 104, 108, 103, 107)];
  const c = [k(0, 101, 105, 99, 103), k(H, 103, 107, 102, 106)];
  const avg = averageCandles([a, b, c, []]);
  assert.deepEqual(avg[0], k(0, 101, 105, 99, 103));
  assert.deepEqual(avg[1], k(H, 103, 107, 102, 106));
  assert.equal(avg.length, 2, 'a candle only one of three venues has opened is not one venue\'s price; a venue with nothing does not count');
  assert.deepEqual(averageCandles([a, b]).map(x => x.t), [0, H, 2 * H], 'one of two is half');
  assert.deepEqual(averageCandles([[], []]), []);
});

test('between reads the newest candle moves as the chart\'s own venue does; a candle it opens since comes in at the average\'s level', () => {
  const average = [k(0, 100, 104, 98, 102), k(H, 102, 106, 101, 105)];
  const read = [k(0, 110, 114, 108, 112), k(H, 112, 116, 111, 115)];
  // The venue rose 3 since it was read, to a new high, and never went under its read low.
  const moved = withLive(average, read, k(H, 112, 118, 111, 118));
  assert.deepEqual(moved[1], k(H, 102, 108, 101, 108));
  assert.deepEqual(moved[0], average[0], 'closed candles stay as read');
  // A fall below the read low moves the low and the close with it.
  assert.deepEqual(withLive(average, read, k(H, 112, 116, 109, 109))[1], k(H, 102, 106, 99, 99));
  // A new candle the read does not have yet: the venue's, shifted by the 10 between it and the average.
  assert.deepEqual(withLive(average, read, k(2 * H, 115, 117, 114, 116))[2], k(2 * H, 105, 107, 104, 106));
  assert.deepEqual(withLive(average, read, k(0, 1, 1, 1, 1)), average, 'an older candle changes nothing');
  assert.deepEqual(withLive(average, [read[0]!], k(H, 1, 1, 1, 1)), average, 'nor does a venue whose read lacks the newest candle');
});

const NOW = Date.UTC(2026, 9, 25, 12, 30);
const state = { timeframe: '1h', marketId: 'binance:BTCUSDT', seriesInstrument: '', candles: [] } as unknown as AppState;
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
/** Candles for every hour of [from, to) up to now, the same walk on every venue at the venue's own level. */
const reader = (asked: { id: string; bars: number }[], fail: (id: string, bars: number) => boolean): SwingReader => async (id, _tf, from, to) => {
  asked.push({ id, bars: (to - from) / H });
  if (fail(id, (to - from) / H)) throw new Error('unreachable');
  const level = 1_000 + swingTargets(BTC).findIndex(target => target.id === id) * 3, candles: [number, number, number, number, number, number, number][] = [];
  for (let t = from, i = 0; t < to && t <= NOW; t += H, i++) { const c = level + 20 * Math.sin(t / H / 7); candles.push([t, c - 1, c + 4, c - 4, c, 10, 1]); }
  return { instrumentId: id, tfMs: H, from, to, asOf: NOW, status: 'ok', candles };
};

test('the Swing pane reads every venue the page reads that lists the coin, leaves out one it cannot read, and reads each again after a minute', async () => {
  // OKX cannot be read at all; Deribit times out on 2,000 candles (it builds 4h from 1h) and answers for 1,000.
  let now = NOW; const asked: { id: string; bars: number }[] = [];
  const book = new SwingBook(reader(asked, (id, bars) => id.startsWith('okx') || (id.startsWith('deribit') && bars > 1_000)), () => {}, () => now);
  assert.equal(book.model(state, now, false)!.status, 'loading');
  await flush();
  const ids = swingTargets(BTC).map(t => t.id);
  assert.equal(ids.length, 11);
  assert.deepEqual(asked.map(a => a.id).sort(), [...ids].sort(), 'each of the eleven venues once');
  const model = book.model(state, now, false)!;
  assert.equal(model.status, 'ok');
  assert.deepEqual(model.venues.map(v => v.id).sort(), ids.filter(id => !id.startsWith('okx') && !id.startsWith('deribit')).sort(), 'the venues that could not be read are left out');
  assert.ok(model.rows.length > 1_000 && model.rows.at(-1)!.value !== null);
  book.model(state, now, false); await flush();
  assert.equal(asked.length, 11, 'nothing again within the minute');
  now += 61_000; book.model(state, now, false); await flush();
  assert.equal(asked.length, 22);
  const again = asked.slice(11);
  assert.ok(again.filter(a => !a.id.startsWith('okx') && !a.id.startsWith('deribit')).every(a => a.bars <= 51), 'the venues read before ask only for their newest stretch');
  assert.equal(again.find(a => a.id.startsWith('deribit'))!.bars, 1_000, 'a failed first read is asked again for half as many');
  assert.ok(book.model(state, now, false)!.venues.some(v => v.id.startsWith('deribit')), 'and comes into the average');
});

test('with no venue to be read, the pane says the history could not be loaded', async () => {
  const book = new SwingBook(reader([], () => true), () => {}, () => NOW);
  book.model(state, NOW, false); await flush();
  assert.equal(book.model(state, NOW, false)!.status, 'failed');
});
