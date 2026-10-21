import test from 'node:test';
import assert from 'node:assert/strict';
import { AHEAD, aheadWarnings, type AheadMinutes } from '../src/shared/volatility/ahead.ts';

const MINUTE = 60_000, T0 = Date.UTC(2026, 9, 10);

/**
 * 1,500 minutes (300 five-minute bars) of a wavy price and a volume that varies a little, with: a flat stretch over bars 197 to 201 whose
 * bars 200 and 201 trade twelve times as much, then a 1 % jump at minute 1,010; a twelve-fold bar 250 at the end of a 1 % climb; and a
 * twelve-fold bar 280 at the end of a flat stretch, with a minute recorded without a price. Bars 250 and 280 would each warn without
 * the climb and without the missing price.
 */
function minutes(): AheadMinutes & { buy: Float64Array; sell: Float64Array; px: Float64Array } {
  const n = 1_500, buy = new Float64Array(n), sell = new Float64Array(n), px = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    buy[i] = 4e5 * (1 + 0.3 * Math.sin(i * 0.37)); sell[i] = 4e5 * (1 + 0.3 * Math.cos(i * 0.53));
    px[i] = 80_000 * (1 + 0.001 * Math.sin(i * 0.21) + 0.0004 * Math.sin(i * 1.7));
  }
  const flat = px[985]!;
  for (let i = 985; i < 1_010; i++) px[i] = flat;
  for (let i = 1_010; i < 1_030; i++) px[i] = flat * 1.01;
  for (let i = 1_000; i < 1_010; i++) { buy[i]! *= 12; sell[i]! *= 12; }
  for (let i = 1_235; i < 1_255; i++) px[i] = px[1_235]! * (1 + 0.0005 * (i - 1_235));
  for (let i = 1_250; i < 1_255; i++) { buy[i]! *= 12; sell[i]! *= 12; }
  for (let i = 1_385; i < 1_405; i++) px[i] = px[1_385]!;
  for (let i = 1_400; i < 1_405; i++) { buy[i]! *= 12; sell[i]! *= 12; }
  px[1_402] = 0;
  return { t0: T0, buy, sell, px };
}

test('a bar trading far more than usual while price is quiet warns once, at its close, and says what came after', () => {
  const m = minutes(), all = aheadWarnings(m, 5, T0 + 1_500 * MINUTE);
  // Bar 201 is the same run of high volume, bar 250 came at the end of a climb, and bar 280 is not whole: none of them warns.
  assert.equal(all.length, 1, JSON.stringify(all.map(w => (w.t - T0) / MINUTE)));
  const w = all[0]!;
  assert.equal(w.tf, 5);
  assert.equal(w.t, T0 + 1_005 * MINUTE, 'the end of bar 200');
  assert.equal(w.price, m.px[1_004]);
  assert.ok(w.z >= AHEAD.z && w.times > 8, `z ${w.z}, ${w.times}× the usual`);
  assert.ok(w.sigma > 0 && w.sigma < 0.005, `σ ${w.sigma}`);
  assert.deepEqual({ moved: w.after.moved, at: w.after.at, down: w.after.down, done: w.after.done }, { moved: 'up', at: T0 + 1_011 * MINUTE, down: 0, done: true },
    'the 1 % jump in minute 1,010 is the move, seen at that minute\'s end');
  assert.equal(w.after.up, 100);
});

test('a warning is known once its bar has ended, and what came after fills in up to now', () => {
  const m = minutes();
  assert.deepEqual(aheadWarnings(m, 5, T0 + 1_004 * MINUTE), [], 'the bar has not ended');
  const [w] = aheadWarnings(m, 5, T0 + 1_007 * MINUTE);
  assert.deepEqual(w!.after, { moved: null, at: null, up: 0, down: 0, done: false }, 'two flat minutes after it');
  const [fresh] = aheadWarnings(m, 5, T0 + 1_005 * MINUTE);
  assert.deepEqual(fresh!.after, { moved: null, at: null, up: null, down: null, done: false }, 'nothing after it yet');
  // Six bars on with no move: over, and none came.
  const still = minutes();
  for (let i = 1_010; i < 1_040; i++) still.px[i] = still.px[1_004]!;
  const [quiet] = aheadWarnings(still, 5, T0 + 1_040 * MINUTE);
  assert.deepEqual(quiet!.after, { moved: null, at: null, up: 0, down: 0, done: true });
});

test('without enough bars before a bar it is not judged', () => {
  // 1,500 minutes are 100 fifteen-minute bars, fewer than the 120 a bar is measured against.
  assert.deepEqual(aheadWarnings(minutes(), 15, T0 + 1_500 * MINUTE), []);
  // From minute 500, bar 200 has only 100 bars before it.
  const m = minutes(), from = 500;
  assert.deepEqual(aheadWarnings({ t0: T0 + from * MINUTE, px: m.px.subarray(from), buy: m.buy.subarray(from), sell: m.sell.subarray(from) }, 5, T0 + 1_500 * MINUTE), []);
});
