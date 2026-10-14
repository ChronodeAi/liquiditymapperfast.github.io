import test from 'node:test';
import assert from 'node:assert/strict';
import { heldOiAt, oiChangeByTime, oiPartsUntil, oiUsdChangeByTime, sumOi, type OiPart } from '../src/app/oi-change.ts';
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

test('every venue\'s open interest reads in coins: Deribit\'s USD at its own mark, OKX in coins not contracts; Bybit\'s history pages back', async () => {
  const asked: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('fapi.binance.com/fapi/v1/openInterest')) return { openInterest: '94000.5' };
    // Bybit's openInterest counts both sides: the single side is what every other venue reports.
    if (url.includes('api.bybit.com/v5/market/tickers')) return { result: { list: [{ openInterest: '112000', singleOpenInterest: '56000' }] } };
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

test('Bybit\'s open interest is read as one side: its single field, or half of the two-sided one where an answer has none', async () => {
  const H = 3_600_000;
  const rows = (single: boolean) => ({ retCode: 0, result: { list: [{ timestamp: String(2 * H), openInterest: '60000', ...(single ? { singleOpenInterest: '30000' } : {}) }] } });
  for (const single of [true, false]) {
    const got = await fetchOiHistory('bybit:BTCUSDT', 300_000, H, 3 * H, async () => rows(single));
    assert.deepEqual(got.map(r => r.close), [30000], single ? 'the single field' : 'half of the two-sided one');
    assert.equal(await fetchOiSample('bybit', async () => ({ retCode: 0, result: { list: [{ openInterest: '60000', ...(single ? { singleOpenInterest: '30000' } : {}) }] } })), 30000);
  }
});

test('an OKX history row is put at the end of its period, the one under way at the time asked', async () => {
  const H = 3_600_000, to = 10 * H + 20 * M;
  // OKX stamps the start of a period with the reading at its end: newest first, the hour under way (10 H) included.
  const get = async (url: string): Promise<unknown> => url.includes('rubik/stat/contracts/open-interest-history')
    ? { code: '0', data: [[String(10 * H), '1', '300', '0'], [String(9 * H), '1', '200', '0'], [String(8 * H), '1', '100', '0']] } : {};
  const rows = await fetchOiHistory('okx:BTC-USDT-SWAP', H, 8 * H, to, get);
  assert.deepEqual(rows.map(r => [r.start, r.close]), [[9 * H, 100], [10 * H, 200], [to, 300]]);
});

test('the OI pane adds venues together unless the chart market is chosen', () => {
  assert.equal(readSettings({}).oiMarkets, 'all');
  assert.equal(readSettings({ oiMarkets: 'chart' }).oiMarkets, 'chart');
  assert.equal(readSettings({ oiMarkets: 'everything' }).oiMarkets, 'all');
});

test('a venue\x27s hourly history holds until its next reading, a gap longer than two hours does not', () => {
  const H = 60 * M, hourly = [bar(0, 100), bar(H, 110), bar(2 * H, 120), bar(8 * H, 200)];
  assert.equal(heldOiAt(hourly, 45 * M, 30 * M)?.[4], 100, 'held past the short carry, until the next reading an hour on');
  assert.equal(heldOiAt(hourly, 2 * H + 20 * M, 30 * M)?.[4], 120, 'the short carry after a reading before a long silence');
  assert.equal(heldOiAt(hourly, 4 * H, 30 * M), null, 'six hours of silence is a gap');
  assert.equal(heldOiAt(hourly, 8 * H + 20 * M, 30 * M)?.[4], 200, 'after the newest, the short carry');
  assert.equal(heldOiAt(hourly, 9 * H, 30 * M), null);
  // On a 15 minute chart an hourly venue beside a 15 minute one is counted in every bar, not every other half hour.
  const sum = sumOi([{ id: 'a', bars: hourly.slice(0, 3) }, { id: 'b', bars: Array.from({ length: 9 }, (_, i) => bar(i * 15 * M, 50)) }], 15 * M);
  assert.ok(sum.venues.every(n => n === 2), JSON.stringify(sum.venues));
});

test('in replay the sum is made of the bars that ended by the moment: a reading after it holds nothing up', () => {
  const Q = 15 * M, parts: OiPart[] = [{ id: 'a', bars: [bar(0, 100), bar(60 * M, 120)] }, { id: 'b', bars: [0, 1, 2, 3, 4, 5].map(i => bar(i * Q, 10)) }];
  const cut = oiPartsUntil(parts, Q, 65 * M);
  assert.equal(oiPartsUntil(parts, Q, 65 * M), cut, 'worked out once per moment');
  const sum = sumOi(cut, Q);
  assert.deepEqual(sum.bars.map(b => [b[0] / M, b[4]]), [[0, 110], [15, 110], [30, 110], [45, 10]], 'a is held for the short carry only: its next reading has not happened yet');
  assert.equal(oiPartsUntil(parts, Q, Infinity), parts, 'live: as they are');
});

test('a change of open interest in USD is a linear market\x27s at the close, an inverse market\x27s at the price its coins were put at', () => {
  const H = 60 * M, closes = new Map([[H, 50_000], [2 * H, 50_000]]), closeAt = (t: number) => closes.get(t);
  // An inverse market whose coins are its USD over 100,000: one more coin is $100,000 more, whatever a candle closed at.
  const inverse: OiPart = { id: 'deribit:BTC-PERPETUAL', bars: [bar(0, 10), bar(H, 11), bar(2 * H, 11)], usdAt: 100_000 };
  const linear: OiPart = { id: 'binance:BTCUSDT', bars: [bar(0, 100), bar(H, 102), bar(2 * H, 101)] };
  const both = oiUsdChangeByTime([], [inverse, linear], H, closeAt);
  assert.equal(both.get(H), 100_000 + 2 * 50_000);
  assert.equal(both.get(2 * H), -50_000);
  assert.deepEqual([...oiUsdChangeByTime(inverse.bars, [], H, closeAt, 100_000)], [[H, 100_000], [2 * H, 0]], 'one inverse market');
  assert.deepEqual([...oiUsdChangeByTime(linear.bars, [], H, closeAt)], [[H, 100_000], [2 * H, -50_000]], 'one linear market');
  // Replay cuts the parts' bars and keeps the price an inverse market's coins were put at.
  const cut = oiPartsUntil([inverse, linear], H, 2 * H);
  assert.equal(cut[0]!.usdAt, 100_000);
  assert.equal(oiUsdChangeByTime([], cut, H, closeAt).get(H), 100_000 + 2 * 50_000);
});
