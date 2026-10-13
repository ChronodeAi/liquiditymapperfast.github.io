import test from 'node:test';
import assert from 'node:assert/strict';
import { OiSampler, type OiSampleMessage } from '../src/server/v2/oi-sampler.mts';

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
