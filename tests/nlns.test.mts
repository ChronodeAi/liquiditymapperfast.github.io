import test from 'node:test';
import assert from 'node:assert/strict';
import { coinText, nlnsCardLines, nlnsModel, type NlnsMarket } from '../src/app/delta/nlns.ts';
import { atOnePrice, inverseOi } from '../src/app/oi-change.ts';
import { readDelta } from '../src/app/delta/settings.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const M = 60_000, H = 3_600_000, T = Date.UTC(2026, 9, 9, 10);
const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });
/** One reading a bar: open = close. */
const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
const none = new Map<number, number>();
const keys = (starts: readonly number[]) => starts.map(() => 0);

test('the four readings: open interest up or down, given to buyers or sellers at market', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H];
  const market: NlnsMarket = { bars: [bar(T - H, 100), bar(T, 110), bar(T + H, 118), bar(T + 2 * H, 114), bar(T + 3 * H, 108)], flows: [flow(5e6), flow(-3e6), flow(-1e6), flow(2e6)] };
  const c = nlnsModel(starts, [market], none, keys(starts), H);
  assert.deepEqual(c.map(x => [x.kind, x.v, x.cum]), [['newLongs', 10, 10], ['newShorts', -8, 2], ['longsClosed', -4, -2], ['shortsClosed', 6, 4]]);
  assert.deepEqual(c.map(x => [x.longs, x.shorts]), [[10, 0], [0, 8], [-4, 0], [0, -6]]);
  assert.deepEqual(c.map(x => [x.cumLongs, x.cumShorts]), [[10, 0], [10, 8], [6, 8], [6, 2]]);
  assert.ok(c.every(x => !x.byPrice && !x.coarse && x.counted === 1 && x.covered === 1));
});

test('venues are each read first, then added: new longs on one and new shorts on another both show, as both sides', () => {
  const starts = [T, T + H];
  const a: NlnsMarket = { bars: [bar(T, 100), bar(T + H, 110)], flows: [null, flow(5)] };
  const b: NlnsMarket = { bars: [bar(T, 200), bar(T + H, 210)], flows: [null, flow(-5)] };
  const [first, c] = nlnsModel(starts, [a, b], none, keys(starts), H);
  assert.equal(first!.kind, null, 'the first readings have nothing before them');
  assert.deepEqual([c!.dOi, c!.longOpened, c!.shortOpened, c!.longs, c!.shorts, c!.v, c!.kind, c!.counted], [20, 10, 10, 10, 10, 0, 'mixed', 2]);
  const lines = nlnsCardLines(c!, '1h', 'BTC', '2 venues added together', 2);
  assert.deepEqual(lines.slice(1, 5).map(l => [l.label, l.text]), [['Open interest', '+20 BTC · +6.67%'], ['Read as', 'Both ways'], ['New longs', '+10 BTC'], ['New shorts', '+10 BTC']]);
  // New longs beside shorts closed: the longs side twice, though open interest did not move.
  const closing: NlnsMarket = { bars: [bar(T, 200), bar(T + H, 190)], flows: [null, flow(5)] };
  const [, d] = nlnsModel(starts, [a, closing], none, keys(starts), H);
  assert.deepEqual([d!.dOi, d!.v, d!.kind], [0, 20, 'newLongs']);
});

test('recorded flow that came out even goes to neither side; flow not recorded leaves the chart\'s closes to decide, and says so', () => {
  const starts = [T, T + H, T + 2 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 115)];
  const closes = new Map([[T, 50_000], [T + H, 49_000], [T + 2 * H, 49_500]]);
  const c = nlnsModel(starts, [{ bars, flows: [null, flow(0), null] }], closes, keys(starts), H);
  assert.deepEqual(c.map(x => [x.kind, x.unassigned, x.v, x.byPrice]), [[null, 0, 0, false], [null, 10, 0, false], ['newLongs', 0, 5, true]]);
  assert.equal(nlnsCardLines(c[1]!, '1h', 'BTC', 'Binance BTCUSDT')[2]!.text, 'takers even');
  // No flow and no closes (the chart's candles are another market's): neither side.
  assert.deepEqual(nlnsModel(starts, [{ bars, flows: [null, null, null] }], none, keys(starts), H).map(x => x.unassigned), [0, 10, 5]);
});

test('a venue read hourly on a one-minute chart: its change lands in the candle of its new reading, given to its takers over the whole hour', () => {
  const starts = Array.from({ length: 61 }, (_, i) => T + i * M);
  // Buyers for the first half hour, sellers twice as heavy for the second: the hour's takers sold.
  const flows = starts.map((_, i) => i === 0 ? null : flow(i <= 30 ? 1 : -2));
  const c = nlnsModel(starts, [{ bars: [bar(T, 1_000), bar(T + H, 1_050)], flows }], none, keys(starts), M);
  assert.equal(c.length, 61, 'every minute between the readings is covered: the reading holds');
  assert.ok(c.slice(0, 60).every(x => x.v === 0 && x.kind === null));
  assert.deepEqual([c[60]!.kind, c[60]!.v, c[60]!.coarse], ['newShorts', -50, true]);
  assert.ok(nlnsCardLines(c[60]!, '1m', 'BTC', 'Bybit BTCUSDT').some(l => /whole stretch/.test(l.text)));
});

test('readings further apart than the hold are a gap: no change across it, and the sums start again after it; a new day starts again', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H, T + 4 * H, T + 5 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 5 * H, 150)];
  const c = nlnsModel(starts, [{ bars, flows: starts.map(() => flow(1)) }], none, keys(starts), H);
  assert.deepEqual(c.map(x => [x.t, x.v, x.run]), [[T, 0, 0], [T + H, 10, 0], [T + 2 * H, 0, 0], [T + 3 * H, 0, 0], [T + 5 * H, 0, 1]], 'held two hours after the reading at 1h, not at 4h; four hours between readings is no change');
  const daily = nlnsModel(starts.slice(0, 3), [{ bars: [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 120)], flows: [flow(1), flow(1), flow(1)] }], none, [0, 0, 1], H);
  assert.deepEqual(daily.map(x => x.cum), [0, 10, 10]);
});

test('an inverse market\'s open interest is put at one price: a move of the price alone opens and closes nothing', () => {
  assert.deepEqual(['deribit:BTC-PERPETUAL', 'deribit:BTC_USDC-PERPETUAL', 'binance:BTCUSDT'].map(inverseOi), [true, false, false]);
  // $1M of contracts throughout, read as coins at each reading's price.
  const candles: CandleRow[] = [[T, 0, 0, 0, 50_000, 0], [T + H, 0, 0, 0, 55_000, 0], [T + 3 * H, 0, 0, 0, 40_000, 0]];
  const bars = [bar(T - H, 1), bar(T, 1e6 / 50_000), bar(T + H, 1e6 / 55_000), bar(T + 2 * H, 1e6 / 55_000), bar(T + 3 * H, 1e6 / 40_000)];
  const at = atOnePrice(bars, candles);
  assert.equal(at.length, 4, 'the bar before the first candle is left out');
  for (const b of at) assert.ok(Math.abs(b[4] - 1e6 / 40_000) < 1e-9, 'every reading at the newest close');
  assert.equal(atOnePrice(bars, []), bars, 'no candles: as they are');
});

test('the words: coins, signed and short; the popup gives the share of open interest, both sides\' sums and names the market', () => {
  assert.deepEqual([coinText(325.4, 'BTC'), coinText(-1_234_567, 'DOGE'), coinText(0.042, 'BTC'), coinText(0, '')], ['+325 BTC', '−1.2M DOGE', '+0.042 BTC', '0']);
  const [, c] = nlnsModel([T, T + H], [{ bars: [bar(T, 92_000), bar(T + H, 92_092)], flows: [null, flow(-1)] }], none, [0, 0], H);
  const lines = nlnsCardLines(c!, '1h', 'BTC', 'Binance BTCUSDT');
  assert.deepEqual(lines.slice(1, 4).map(l => [l.label, l.text]), [['Open interest', '+92 BTC · +0.10%'], ['Read as', 'New shorts'], ['New shorts', '+92 BTC']]);
  assert.deepEqual(lines.slice(4, 7).map(l => [l.label, l.text]), [['Longs', '0 BTC · since the start 0 BTC'], ['Shorts', '+92 BTC · since the start +92 BTC'], ['Net', '−92 BTC · since the start −92 BTC']]);
  assert.match(lines[lines.length - 1]!.text, /Binance BTCUSDT/);
  assert.equal(readDelta({ style: 'nlns' }).style, 'nlns');
  assert.deepEqual([readDelta({}).nlns, readDelta({ nlns: 'split' }).nlns, readDelta({ nlns: 'both' }).nlns], ['net', 'split', 'net'], 'net by default; split kept; anything else net');
});
