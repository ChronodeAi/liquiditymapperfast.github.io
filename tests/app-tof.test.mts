import test from 'node:test';
import assert from 'node:assert/strict';
import { TofBook, tofIds, tofMarkets } from '../src/app/tof/book.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { readTof, TOF_DEFAULTS } from '../src/app/tof/settings.ts';
import { tofLevelLines } from '../src/app/tof/lines.ts';
import { tofCardLines } from '../src/app/panes/tof-pane.ts';
import { initialState, type AppState, type CandleRow } from '../src/app/store.ts';
import type { DeltaTrack } from '../src/app/delta/candles.ts';

const MIN = 60_000, T = Date.UTC(2026, 9, 20);
const markets: AppState['markets'] = [
  { instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', marketType: 'perpetual' },
  { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', base: 'BTC', marketType: 'spot' },
  { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC', marketType: 'perpetual' },
  { instrumentId: 'okx:BTC-USDT-SWAP', venue: 'okx', base: 'BTC', marketType: 'perpetual' },
  { instrumentId: 'bybit:ETHUSDT', venue: 'bybit', base: 'ETH', marketType: 'perpetual' },
];

test('settings: Binance and Bybit, levels and the by-price histogram on, every candle leaving a level, taken ones off; junk gets the defaults', () => {
  assert.deepEqual(TOF_DEFAULTS, { venues: 'pair', levels: true, from: 'all', taken: false, histogram: true });
  assert.deepEqual(readTof(undefined), TOF_DEFAULTS);
  assert.deepEqual(readTof({ venues: 'all', levels: false, from: 'toxic', taken: true, histogram: 0 }), { venues: 'all', levels: false, from: 'toxic', taken: true, histogram: true });
  assert.equal(readTof({ from: 'some', venues: 'okx' }).from, 'all');
  assert.equal(readTof({ venues: 'okx' }).venues, 'pair');
});

test('the venues read are the chart coin\'s Binance and Bybit perpetuals, in that order', () => {
  assert.deepEqual(tofIds({ markets, marketId: 'okx:BTC-USDT-SWAP' }), ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  assert.deepEqual(tofIds({ markets, marketId: 'bybit:ETHUSDT' }), ['bybit:ETHUSDT'], 'ETH has no Binance perpetual in the list');
  assert.deepEqual(tofIds({ markets, marketId: 'nowhere' }), []);
});

test('the venue choice: Binance and Bybit, every perpetual the flow column adds up, or every market it adds up', () => {
  const flow = new FlowBook();
  // Binance spot comes over two feeds; the flow column counts it once.
  for (const id of ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'binancespot:BTCUSDT', 'binance:BTCUSDT:spot']) flow.apply([[id, T, 1_000, 500, 100_000]]);
  const withSpot: AppState['markets'] = [...markets, { instrumentId: 'binance:BTCUSDT:spot', venue: 'binance', base: 'BTC', marketType: 'spot' }];
  const state = (venues: 'pair' | 'perps' | 'all', disabledVenues: string[] = []): AppState => ({ ...initialState(), markets: withSpot, marketId: 'binance:BTCUSDT', disabledVenues, tof: { ...TOF_DEFAULTS, venues } });
  assert.deepEqual(tofMarkets(state('pair'), flow), ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  assert.deepEqual(tofMarkets(state('perps'), flow).sort(), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP']);
  const all = tofMarkets(state('all'), flow);
  assert.equal(all.filter(id => id.includes('spot')).length, 1, `Binance spot once: ${all.join(', ')}`);
  assert.equal(all.length, 4);
  assert.ok(!tofMarkets(state('perps', ['okx']), flow).includes('okx:BTC-USDT-SWAP'), 'a venue switched off is not read');
});

/** A venue whose taker volume is `perMinute(m)` USD in minute m (from T), a third of it bought. */
function flatTrack(perMinute: (m: number) => number): DeltaTrack {
  const cum = (sec: number): number => { let s = 0; for (let m = 0; m * 60 <= sec - T / 1000; m++) s += perMinute(m) * Math.min(60, sec - T / 1000 - m * 60 + 1) / 60; return s; };
  return { first: T / 1000 - 3_600, cumGross: sec => cum(sec), cumDelta: sec => -cum(sec) / 3 };
}

test('the model weighs each venue\'s volume by its candle\'s range, judges it against its own past, and leaves levels', () => {
  const n = 400, bursts = new Set([360]);
  // 5-minute candles of a flat price that wobbles 10 points, and at candle 360 jumps 300 points with five times the volume.
  const candles: CandleRow[] = Array.from({ length: n }, (_, i) => {
    const o = 100_000 + (i >= 361 ? 300 : 0) + (i % 3) * 5, burst = bursts.has(i);
    return [T + i * 5 * MIN, o, burst ? o + 310 : o + 10 + (i % 4), burst ? o - 2 : o - 10, burst ? o + 300 : o + 2, 1];
  });
  const volume = (m: number): number => (bursts.has(Math.floor(m / 5)) ? 5 : 1) * (1_000_000 + (m % 7) * 50_000);
  const tracks: Record<string, DeltaTrack> = { 'binance:BTCUSDT': flatTrack(volume), 'bybit:BTCUSDT': flatTrack(m => volume(m) / 2) };
  const hub = { flow: { track: (id: string) => tracks[id], version: 1, loads: 1, get: () => undefined, missing: () => [] as string[] }, ensureFlow: async () => {}, ensureFlowMinutes: async () => {} };
  const state: AppState = { ...initialState(), markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', timeframe: '5m', candles, tof: { ...TOF_DEFAULTS, from: 'toxic' } };
  const end = T + n * 5 * MIN, book = new TofBook();
  const model = book.model(state, hub as never, T + 300 * 5 * MIN, end, end)!;
  assert.deepEqual(model.ids, ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  const at = (i: number) => model.rows.find(r => r.candle.t === T + i * 5 * MIN)!;
  const quiet = at(350), burst = at(360);
  // Binance's reading: its 5 minutes of volume times the square root of the candle's range over its open.
  const binVolume = [0, 1, 2, 3, 4].reduce((s, k) => s + volume(350 * 5 + k), 0);
  assert.ok(Math.abs(quiet.cells[0]!.tof! - binVolume * Math.sqrt((candles[350]![2] - candles[350]![3]) / candles[350]![1])) < 1e-6 * binVolume);
  assert.ok(Math.abs(quiet.cells[1]!.tof! - quiet.cells[0]!.tof! / 2) < 1e-6 * binVolume, 'Bybit traded half as much');
  assert.ok(Math.abs(quiet.cells[0]!.buy / (quiet.cells[0]!.buy + quiet.cells[0]!.sell) - 1 / 3) < 1e-9, 'a third bought at market');
  assert.ok(burst.cells[0]!.z! > 2 && burst.cells[1]!.z! > 2 && burst.z! > 2, `a burst on both venues and together: ${burst.cells[0]!.z} ${burst.z}`);
  assert.ok(Math.abs(quiet.z!) < 2);
  // Levels from toxic only: the regular wobble makes a few too, all taken since (price stays around them); the burst's is untapped, as price
  // jumped 300 points and never came back down to its open.
  assert.ok(model.levels.every(l => l.z >= 2));
  assert.deepEqual(model.levels.filter(l => l.taken === null).map(l => [(l.t - T) / 5 / MIN, l.price]), [[360, candles[360]![1]]]);
  assert.equal(book.model(state, hub as never, T + 300 * 5 * MIN, end, end), model, 'asked again with nothing changed: the same model');
  assert.equal(new TofBook().model({ ...state, seriesInstrument: 'okx:BTC-USDT-SWAP' }, hub as never, T, end, end), null, 'needs the chart\'s own candles');
  // The popup of the burst candle.
  const lines = tofCardLines(burst, model.ids, '5m');
  assert.equal(lines[0]!.text, 'Toxic flow · 5m');
  assert.match(lines.find(l => l.label === 'Binance')!.text, /^\$\S+ · \S+× usual · z \d+\.\d toxic$/);
  assert.equal(lines.find(l => l.label === 'Taker buys')!.text, '33 %');
  assert.match(lines.find(l => l.label === 'Together')!.text, /toxic$/);
  const burstLevel = model.levels.find(l => l.taken === null)!, level = tofLevelLines(burstLevel);
  assert.equal(level.find(l => l.label === 'Price')!.text, '100,000.0');
  assert.ok(level.some(l => l.text === 'Untapped: price has not traded back to it.'));
  assert.ok(tofLevelLines({ ...burstLevel, taken: T }).some(l => /^Taken at /.test(l.text)));
});

test('ranked, the popup puts the venue that stood out most first and keeps to six', () => {
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bitget:BTCUSDT', 'hyperliquid:BTC-PERP', 'deribit:BTC-PERPETUAL', 'coinbase:BTC-USD', 'bybitspot:BTCUSDT'];
  const z = [1.2, 0.4, 3.1, 2.2, -0.5, null, 1.0, 0.1];
  const row = { candle: { t: T, o: 100, h: 101, l: 99 }, total: 9e6, z: 2.1, usual: 3e6, cells: ids.map((_, i) => ({ tof: 1e6 * (i + 1), z: z[i]!, usual: 1e6, buy: 1, sell: 1 })) };
  const venues = (lines: ReturnType<typeof tofCardLines>): string[] => lines.filter(l => l.mark).map(l => l.label!);
  assert.deepEqual(venues(tofCardLines(row, ids, '5m', true)), ['OKX', 'Bitget', 'Binance', 'Coinbase', 'Bybit', 'Bybit spot'], 'by z, the most unusual first');
  assert.ok(tofCardLines(row, ids, '5m', true).some(l => l.text === 'and 2 more'), 'Hyperliquid (z -0.5) and Deribit (not judged yet) are left out');
  assert.deepEqual(venues(tofCardLines(row, ids.slice(0, 2), '5m')), ['Binance', 'Bybit'], 'unranked: in order');
});
