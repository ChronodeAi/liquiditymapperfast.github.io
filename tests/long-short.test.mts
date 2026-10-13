import test from 'node:test';
import assert from 'node:assert/strict';
import { LongShortCache, fetchLongShort, lsPeriodOf, lsReading, parseLsSeries, shareOfRatio } from '../src/shared/long-short.ts';
import { lsAt } from '../src/app/panes/ls-pane.ts';
import type { Fetcher } from '../src/shared/history.ts';
import { LAYOUT_KEYS, readSettings } from '../src/app/store.ts';

const M = 60_000, H = 3_600_000, NOW = Date.UTC(2026, 9, 13, 18, 50);

/** A fake venue: answers by the URL's start, and keeps every URL it was asked. */
function fake(answers: Record<string, (url: URL) => unknown>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const get = (async (raw: string) => {
    asked.push(raw);
    const url = new URL(raw), hit = Object.keys(answers).find(prefix => raw.startsWith(prefix));
    if (!hit) throw new Error(`no answer for ${raw}`);
    return answers[hit]!(url);
  }) as Fetcher & { asked: string[] };
  get.asked = asked;
  return get;
}

test('a reading must add up: shares to 1 and the ratio to long over short, within the rounding; never a made-up 50 %', () => {
  assert.deepEqual(lsReading(1, 0.5564, 0.4436, 1.2543), { t: 1, long: 0.5564 }, "Binance's own numbers");
  assert.equal(lsReading(1, 0.6, 0.3), null, 'shares that do not add up to 1');
  assert.equal(lsReading(1, 0.6, 0.4, 2), null, 'a ratio that is not long over short');
  assert.equal(lsReading(1, NaN), null);
  assert.equal(lsReading(1, 1), null, 'all long is not a share a venue gives');
  assert.equal(lsReading(0, 0.5), null, 'no time');
  assert.ok(Math.abs(shareOfRatio(1.25) - 0.5556) < 1e-4, 'L/S 1.25 is 55.6 % long');
});

test("each venue's period: the longest no longer than the candle, five minutes at the finest", () => {
  assert.deepEqual([lsPeriodOf('binance', M), lsPeriodOf('binance', H), lsPeriodOf('bybit', 2 * H), lsPeriodOf('okx', 15 * M), lsPeriodOf('okx', 7 * 24 * H), lsPeriodOf('hyperliquid', H)],
    [5 * M, H, H, 5 * M, 24 * H, null]);
});

test("the venues' answers as they come (measured 2026-10-13): Binance pages back from endTime, Bybit newest first, OKX a ratio, Bitget its 30 periods", async () => {
  const row = (t: number) => ({ symbol: 'BTCUSDT', longAccount: '0.5564', longShortRatio: '1.2543', shortAccount: '0.4436', timestamp: t });
  const get = fake({
    'https://fapi.binance.com/futures/data/globalLongShortAccountRatio': url => {
      const end = Number(url.searchParams.get('endTime'));
      // Two full pages and a short one, oldest first as Binance sends them.
      const n = end > NOW - 1_000 * 5 * M ? 500 : 20;
      return Array.from({ length: n }, (_, i) => row(Math.floor(end / (5 * M)) * 5 * M - (n - 1 - i) * 5 * M));
    },
    'https://api.bybit.com/v5/market/account-ratio': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.594', sellRatio: '0.406', timestamp: String(NOW - 10 * M) }, { buyRatio: '0.5945', sellRatio: '0.4055', timestamp: String(NOW - 15 * M) }] } }),
    'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract': () => ({ code: '0', data: [[String(NOW - 10 * M), '1.2192867221330219'], [String(NOW - 15 * M), 'x']] }),
    'https://api.bitget.com/api/v2/mix/market/account-long-short': () => ({ code: '00000', data: [{ longAccountRatio: '0.6174', shortAccountRatio: '0.3826', longShortAccountRatio: '1.6136', ts: String(NOW - 10 * M) }] }),
  });
  const binance = await fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, get, NOW);
  assert.ok(binance.length > 500 && binance.every((p, i) => i === 0 || p.t > binance[i - 1]!.t), 'pages joined, oldest first, no repeats');
  assert.equal(get.asked.filter(u => u.includes('binance')).length, 2, 'until a page is short');
  assert.deepEqual((await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).map(p => p.long), [0.5945, 0.594]);
  const okx = await fetchLongShort('okx', 'BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW, get, NOW);
  assert.equal(okx.length, 1, 'a ratio that is not a number is left out'); assert.ok(Math.abs(okx[0]!.long - 0.5494) < 1e-3);
  assert.deepEqual((await fetchLongShort('bitget', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).map(p => p.long), [0.6174]);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW, get, NOW), /no such series/, "only Binance publishes its top traders'");
  // Binance keeps 30 days: nothing older is asked for.
  const old = fake({ 'https://fapi.binance.com/': () => [] });
  await fetchLongShort('binance', 'BTCUSDT', 'topAccounts', H, NOW - 60 * 24 * H, NOW - 40 * 24 * H, old, NOW);
  assert.equal(old.asked.length, 0);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 10001, retMsg: 'bad' }) }), NOW), /bybit/, 'a changed API fails, not empty');
});

test('the cache: one request per series at a time, the newest stretch again at most once a period, OKX server only in a page, failures reported', async () => {
  let now = NOW;
  const get = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 5 * M) }] } }) });
  const cache = new LongShortCache(get, true, () => now);
  const [a, b] = await Promise.all([cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW), cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)]);
  assert.equal(get.asked.length, 1, 'two questions at once share one request');
  assert.deepEqual([a.status, a.population, a.periodMs, a.points.length, b.points.length], ['ok', 'accounts', 5 * M, 1, 1]);
  now += 2 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 1, 'not due yet');
  now += 4 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 2, 'a period later, the newest stretch again');
  assert.equal((await cache.series('okx:BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW)).status, 'serverOnly');
  assert.equal((await cache.series('hyperliquid:BTC', 'accounts', 5 * M, NOW - H, NOW)).status, 'unsupported');
  const broken = new LongShortCache(fake({}), false, () => now);
  const failed = await broken.series('binance:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW);
  assert.deepEqual([failed.status, failed.population, failed.points], ['failed', 'topPositions', []]);
});

test('over the wire: a series of the wrong shape is an error, a reading out of range or order is dropped', () => {
  assert.throws(() => parseLsSeries({ id: 'x', status: 'great', population: null, periodMs: 0, points: [] }));
  const s = parseLsSeries({ id: 'binance:BTCUSDT', population: 'accounts', periodMs: 300_000, status: 'ok', points: [{ t: 2, long: 0.55 }, { t: 1, long: 0.56 }, { t: 3, long: 1.2 }, { t: 4, long: 0.57 }] });
  assert.deepEqual(s.points, [{ t: 2, long: 0.55 }, { t: 4, long: 0.57 }]);
});

test('a reading holds until the next, and for three periods after the newest; nothing before the first', () => {
  const points = [{ t: 0, long: 0.55 }, { t: 5 * M, long: 0.56 }];
  assert.deepEqual([lsAt(points, -1, 5 * M), lsAt(points, 3 * M, 5 * M)?.long, lsAt(points, 19 * M, 5 * M)?.long, lsAt(points, 20 * M, 5 * M)], [null, 0.55, 0.56, null]);
});

test('the Binance series is a saved setting and a layout setting: only the three it publishes, all accounts by default; the pane is off by default', () => {
  assert.deepEqual([readSettings({}).lsMetric, readSettings({ lsMetric: 'topPositions' }).lsMetric, readSettings({ lsMetric: 'whales' }).lsMetric], ['accounts', 'topPositions', 'accounts']);
  assert.equal(readSettings({}).show.ls, false);
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('lsMetric'));
});
