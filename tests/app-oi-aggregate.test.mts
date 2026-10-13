import test from 'node:test';
import assert from 'node:assert/strict';
import { oiChangeByTime, sumOi, type OiPart } from '../src/app/oi-change.ts';
import { carriedOiDeltas, nlnsSumCandles } from '../src/app/delta/nlns.ts';
import { fetchOiSample, fetchOiHistory, OI_SAMPLE_VENUES } from '../src/shared/history.ts';
import { readSettings } from '../src/app/store.ts';
import type { OiBar } from '../src/app/store.ts';

const M = 60_000;
const bar = (t: number, c: number): OiBar => [t, c, c, c, c];

test('venues added together: a venue whose readings start is not counted as positions opened, and one read every five minutes is carried', () => {
  // A: a reading every minute, rising by 10. B: from minute 3, every minute. C: every fifth minute.
  const a: OiPart = { id: 'binance:BTCUSDT', bars: [0, 1, 2, 3, 4, 5].map(i => bar(i * M, 1_000 + 10 * i)) };
  const b: OiPart = { id: 'bybit:BTCUSDT', bars: [3, 4, 5].map(i => bar(i * M, 500 + i)) };
  const c: OiPart = { id: 'okx:BTC-USDT-SWAP', bars: [0, 5].map(i => bar(i * M, 300 + i * 4)) };
  const parts = [a, b, c], sum = sumOi(parts, M);
  assert.deepEqual(sum.bars.map(x => x[4]), [1300, 1310, 1320, 1030 + 503 + 300, 1040 + 504 + 300, 1050 + 505 + 320], 'the sum, C carried at 300 between its readings');
  assert.deepEqual(sum.venues, [2, 2, 2, 3, 3, 3]);
  assert.equal(sum.change.get(3 * M), 10, 'B starting at minute 3 adds nothing to that minute\'s change: only A\'s +10 (C is carried, unchanged)');
  assert.equal(sum.counted.get(3 * M), 2);
  assert.equal(sum.change.get(4 * M), 10 + 1);
  assert.equal(sum.change.get(5 * M), 10 + 1 + 20, 'C\'s new reading counts its whole step from the carried one');
  assert.equal(sum.change.has(0), false, 'the first bar has nothing before it');
  // The difference of two sums would have shown B joining as +503 opened.
  assert.notEqual(sum.bars[3]![4] - sum.bars[2]![4], sum.change.get(3 * M));
  assert.equal(oiChangeByTime(sum.bars, parts, M), oiChangeByTime(sum.bars, parts, M), 'worked out once per set of parts');
  assert.deepEqual([...oiChangeByTime(sum.bars, parts, M)], [...sum.change]);
  // A reading older than the carry is not carried: a venue gone quiet leaves the sum rather than standing still in it.
  const late = sumOi([a, { id: 'x:BTC', bars: [bar(0, 50)] }], M, 2 * M);
  assert.deepEqual(late.venues, [2, 2, 2, 1, 1, 1]);
});

test('on a one-minute chart a venue read every five minutes changes in the bar of its new reading, by the whole step', () => {
  const fiveMinutes: OiPart = { id: 'bybit:BTCUSDT', bars: [bar(0, 300), bar(5 * M, 330), bar(10 * M, 330)] };
  const everyMinute: OiPart = { id: 'binance:BTCUSDT', bars: [0, 1, 2, 3, 4, 5].map(i => bar(i * M, 1_000 + i)) };
  const sum = sumOi([fiveMinutes, everyMinute], M);
  assert.equal(sum.change.get(5 * M), 30 + 1, 'Bybit +30 from its carried reading one minute before, Binance +1');
  assert.equal(sum.change.get(3 * M), 1, 'Bybit carried, unchanged');
  assert.equal(sum.change.get(10 * M), 0, 'both unchanged: Binance carried at its reading of five minutes before');
  assert.equal(sum.counted.get(10 * M), 2);
});

test('NL/NS over venues gives each venue\'s change to its own takers, then adds them up', () => {
  const starts = [0, M, 2 * M];
  const up = carriedOiDeltas([bar(0, 100), bar(M, 110), bar(2 * M, 130)], starts, M);
  const down = carriedOiDeltas([bar(0, 200), bar(M, 195), bar(2 * M, 190)], starts, M);
  assert.deepEqual(up.map(d => d?.dOi ?? null), [null, 10, 20]);
  const flow = (delta: number) => ({ delta, buy: Math.max(0, delta), sell: Math.max(0, -delta) }) as never;
  // Venue A: buyers, OI up (new longs +). Venue B: buyers too, OI down (shorts closed +). One with sellers would count against.
  const candles = nlnsSumCandles(starts, [{ deltas: up, flows: [null, flow(5), flow(-5)] }, { deltas: down, flows: [null, flow(3), flow(3)] }], [0, 0, 0], [0, 0, 0]);
  assert.deepEqual(candles.map(c => [c.t, c.dOi, c.v]), [[M, 5, 10 + 5], [2 * M, 15, -20 + 5]]);
  assert.equal(candles[0]!.kind, 'newLongs');
  assert.equal(candles[1]!.kind, 'newShorts', 'OI up on the sum, given mostly to sellers');
  assert.equal(candles[1]!.cum, 15 - 15);
  // Where a venue's flow is not recorded, the chart's price decides, and the candle says so.
  const byPrice = nlnsSumCandles(starts, [{ deltas: up, flows: [null, null, null] }], [0, -1, 1], [0, 0, 0]);
  assert.deepEqual(byPrice.map(c => [c.v, c.byPrice]), [[-10, true], [20, true]]);
});

test('every venue\'s open interest reads in coins: Deribit\'s USD at its own mark, OKX in coins not contracts; Bybit\'s history pages back', async () => {
  const asked: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('fapi.binance.com/fapi/v1/openInterest')) return { openInterest: '94000.5' };
    if (url.includes('api.bybit.com/v5/market/tickers')) return { result: { list: [{ openInterest: '56000' }] } };
    if (url.includes('okx.com/api/v5/public/open-interest')) return { data: [{ oi: '2940000', oiCcy: '29400', ts: '1' }] };
    if (url.includes('api.bitget.com')) return { data: { openInterestList: [{ symbol: 'BTCUSDT', size: '32000' }] } };
    if (url.includes('deribit.com')) return { result: [{ open_interest: 850_000_000, mark_price: 85_000 }] };
    if (url.includes('api.bybit.com/v5/market/open-interest')) {
      const end = Number(new URL(url).searchParams.get('endTime'));
      const list = Array.from({ length: 200 }, (_, i) => ({ timestamp: String(end - (end % 300_000) - i * 300_000), openInterest: '50000' }));
      return { result: { list } };
    }
    return {};
  };
  const coins = Object.fromEntries(await Promise.all(OI_SAMPLE_VENUES.filter(v => v !== 'hyperliquid').map(async v => [v, await fetchOiSample(v, get)] as const)));
  assert.deepEqual(coins, { binance: 94000.5, bybit: 56000, bitget: 32000, okx: 29400, deribit: 10_000 });
  const to = 10 * 86_400_000, rows = await fetchOiHistory('bybit:BTCUSDT', 300_000, to - 2 * 86_400_000, to, get);
  assert.ok(rows.length >= 576 && rows.length <= 578, `two days of five-minute bars over pages of 200: ${rows.length}`);
  assert.ok(rows.every((r, i) => i === 0 || Number(r.start) > Number(rows[i - 1]!.start)), 'oldest first, no bar twice');
  assert.deepEqual(await fetchOiHistory('bitget:BTCUSDT', 300_000, 0, to, get), [], 'a venue without a history');
});

test('the OI pane adds venues together unless the chart market is chosen', () => {
  assert.equal(readSettings({}).oiMarkets, 'all');
  assert.equal(readSettings({ oiMarkets: 'chart' }).oiMarkets, 'chart');
  assert.equal(readSettings({ oiMarkets: 'everything' }).oiMarkets, 'all');
});
