import test from 'node:test';
import assert from 'node:assert/strict';
import { OiSampler, oiListingOf, type OiSampleMessage } from '../src/server/v2/oi-sampler.mts';

const NOW = 20 * 86_400_000;

test('the server samples the venues the feed manager does not read, writing their history first, oldest first', async () => {
  const applied: { message: OiSampleMessage; venue: string }[] = [], recorded: OiSampleMessage[] = [], asked: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('api.bybit.com/v5/market/open-interest')) {
      const end = Number(new URL(url).searchParams.get('endTime')), step = url.includes('intervalTime=1h') ? 3_600_000 : 300_000;
      return { result: { list: Array.from({ length: 3 }, (_, i) => ({ timestamp: String(end - (end % step) - i * step), openInterest: '100' })) } };
    }
    if (url.includes('api.bybit.com/v5/market/tickers')) return { result: { list: [{ openInterest: '123' }] } };
    if (url.includes('deribit.com')) return { result: [{ open_interest: 85_000_000, mark_price: 85_000 }] };
    throw new Error(`not expected: ${url}`);
  };
  const sampler = new OiSampler((message, venue) => applied.push({ message, venue }), message => recorded.push(message), get, () => NOW, 3_600_000);
  sampler.sync(['binance:BTCUSDT', 'hyperliquid:BTC-PERP', 'bybit:BTCUSDT', 'deribit:BTC-PERPETUAL', 'bybitspot:BTCUSDT']);
  await sampler.round();
  assert.ok(!asked.some(url => url.includes('binance.com') || url.includes('hyperliquid')), 'Binance and Hyperliquid are the feed manager\'s');
  assert.ok(recorded.length > 0 && recorded.every(m => m.instrumentId === 'bybit:BTCUSDT' && m.sourceTimestamp !== null), 'Bybit\'s history went to the store (Deribit has none)');
  assert.ok(recorded.every((m, i) => i === 0 || Number(m.sourceTimestamp) > Number(recorded[i - 1]!.sourceTimestamp)), 'oldest first');
  assert.deepEqual(applied.map(a => [a.venue, a.message.instrumentId, a.message.base, a.message.quality]), [['bybit', 'bybit:BTCUSDT', 123, 'sampled'], ['deribit', 'deribit:BTC-PERPETUAL', 1_000, 'sampled']]);
  const before = recorded.length;
  await sampler.round();
  assert.equal(recorded.length, before, 'the history is read once');
  assert.equal(applied.length, 4, 'then a reading a round');
  sampler.sync([]);
  sampler.close();
  await sampler.round();
  assert.equal(applied.length, 4, 'closed: nothing more');
});

test('each instrument is read with its own listing, a spot book is never sampled, and a failed history is tried again later', async () => {
  assert.deepEqual(oiListingOf('bybit:ETHUSDT'), { symbol: 'ETHUSDT', unit: 1 });
  assert.deepEqual(oiListingOf('bybit:1000PEPEUSDT'), { symbol: '1000PEPEUSDT', unit: 1000 });
  assert.deepEqual(oiListingOf('deribit:ETH-PERPETUAL'), { symbol: 'ETH-PERPETUAL', unit: 1, inverse: true });
  assert.deepEqual(oiListingOf('deribit:SOL_USDC-PERPETUAL'), { symbol: 'SOL_USDC-PERPETUAL', unit: 1 });
  assert.equal(oiListingOf('bybit:BTCUSDT:spot'), null);
  let clock = NOW, failing = true;
  const asked: string[] = [], recorded: OiSampleMessage[] = [], applied: OiSampleMessage[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('open-interest?category')) { if (failing) throw new Error('HTTP 429'); return { result: { list: [{ timestamp: String(clock - (clock % 300_000)), openInterest: '900' }] } }; }
    if (url.includes('tickers')) return { result: { list: [{ openInterest: '10' }] } };
    throw new Error(url);
  };
  const sampler = new OiSampler(m => applied.push(m), m => recorded.push(m), get, () => clock, 3_600_000);
  sampler.sync(['bybit:ETHUSDT', 'bybit:ETHUSDT:spot']);
  await sampler.round();
  assert.ok(asked.every(url => url.includes('symbol=ETHUSDT')), 'ETH asked for, not BTC');
  assert.deepEqual(applied.map(m => m.instrumentId), ['bybit:ETHUSDT'], 'the spot book is not sampled; the live reading goes on while the history waits');
  assert.equal(recorded.length, 0);
  const tries = asked.length; failing = false;
  await sampler.round();
  assert.equal(asked.length - tries, 1, 'within the minute after a failure only the live reading is asked');
  clock += 61_000; await sampler.round();
  assert.ok(recorded.length > 0, 'the history is read once the wait is over');
  sampler.close();
});
