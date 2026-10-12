import test from 'node:test';
import assert from 'node:assert/strict';
import { KeptCache, PROTECT_MS } from '../src/shared/kept-cache.ts';
import { DepthRecorder, COLUMN_MS, type Column } from '../src/server/v2/recorder.mts';

/**
 * What a recorder keeps for the next question: least recently asked first, but an entry asked within PROTECT_MS is never let go to make
 * room, so a page asking again and again for more than the cache holds finds most of it each time instead of none of it.
 */

test('the least recently asked goes first once nothing kept was asked within PROTECT_MS', () => {
  let now = 0;
  const cache = new KeptCache<number>(80, () => now), keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  for (const [i, key] of keys.entries()) cache.set(key, i, 2);
  assert.equal(cache.weight, 80); assert.equal(cache.size, 40);
  now += PROTECT_MS + 1;
  assert.equal(cache.get('k0'), 0, 'asking for k0 makes it the most recently asked');
  cache.set('new', 40, 2);
  // Room is made in one go, down to seven eighths of the limit (70), from the least recently asked: k1 to k5 go, k0 (just asked) stays.
  assert.deepEqual(keys.filter(key => !cache.has(key)), ['k1', 'k2', 'k3', 'k4', 'k5']);
  assert.equal(cache.weight, 72); assert.equal(cache.has('new'), true);
});

test('an entry asked within PROTECT_MS is not let go: the new one is not kept, until they age', () => {
  let now = 0;
  const cache = new KeptCache<string>(6, () => now);
  for (const key of ['a', 'b', 'c']) cache.set(key, key, 2);
  now += PROTECT_MS / 2;
  cache.set('d', 'd', 2);
  assert.equal(cache.has('d'), false, 'all three were asked within PROTECT_MS');
  assert.deepEqual(['a', 'b', 'c'].filter(key => cache.has(key)), ['a', 'b', 'c']);
  cache.get('a');
  now += PROTECT_MS / 2 + 1;
  cache.set('d', 'd', 2);
  assert.deepEqual(['a', 'b', 'c', 'd'].filter(key => cache.has(key)), ['a', 'c', 'd'], 'b, the least recently asked, has aged and goes; a was asked since');
});

test('a page asking every 30 s for more than the cache holds finds what it found the time before', () => {
  let now = 0;
  const cache = new KeptCache<number>(1_000, () => now);
  const keys = Array.from({ length: 1_200 }, (_, i) => `x|${i}`);
  const hits: number[] = [];
  for (let pass = 0; pass < 4; pass++, now += 30_000) {
    let found = 0;
    for (const [i, key] of keys.entries()) { if (cache.get(key) !== undefined) found++; else cache.set(key, i, 1); }
    hits.push(found);
  }
  // Letting the least recently asked go would find none: each entry goes just before it is asked again.
  assert.deepEqual(hits, [0, 1_000, 1_000, 1_000]);
});

test('replacing an entry, deleting and letting go by a test keep the weight right; a limit of nothing keeps nothing', () => {
  let now = 0;
  const cache = new KeptCache<string>(10, () => now);
  cache.set('a', 'one', 3); cache.set('a', 'two', 4); cache.set('b', 'b', 2); cache.set('c', 'c', 1);
  assert.equal(cache.get('a'), 'two'); assert.equal(cache.weight, 7);
  cache.delete('b'); cache.delete('missing'); assert.equal(cache.weight, 5);
  cache.deleteWhere(key => key === 'c'); assert.equal(cache.weight, 4); assert.equal(cache.size, 1);
  cache.set('big', 'big', 11); assert.equal(cache.has('big'), false, 'heavier than the limit');
  // A full cache whose entries are all recent takes nothing new; once one is let go there is room again at once.
  cache.set('d', 'd', 6); cache.set('e', 'e', 1); assert.equal(cache.has('e'), false);
  cache.delete('a'); cache.set('e', 'e', 1); assert.equal(cache.has('e'), true);
  now += 1;
  const none = new KeptCache<string>(0, () => now); none.set('a', 'a', 1); assert.equal(none.size, 0);
});

test('a recorder whose windows do not all fit answers the same twice, with the windows it kept as they were', () => {
  const T0 = Date.UTC(2026, 9, 1), now = T0 + 120 * COLUMN_MS;
  let seed = 5;
  const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
  const columns: Column[] = Array.from({ length: 120 }, (_, m) => {
    const bins = Int32Array.from({ length: 20 }, (_, i) => 1_000 + i * 2);
    return { t: T0 + m * COLUMN_MS, n: 12, bins, bid: Float32Array.from(bins, () => rnd() * 1e5), ask: Float32Array.from(bins, () => rnd() * 1e5) };
  });
  // 24 windows of five minutes, each of the same 20 bins; room for ten of them.
  const recorder = new DepthRecorder({ now: () => now, mergedCacheBins: 200 });
  recorder.columns.set('x:BTC', columns);
  const first = recorder.query('x:BTC', T0, now, 5 * COLUMN_MS), again = recorder.query('x:BTC', T0, now, 5 * COLUMN_MS);
  assert.deepEqual(again, first);
  assert.equal(first.length, 24);
  assert.equal(again.filter((column, i) => column === first[i]).length, 10, 'the ten kept the first time are the ones found');
  assert.equal(recorder.cacheStats().mergedWindows, 10);
});
