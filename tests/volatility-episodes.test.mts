import test from 'node:test';
import assert from 'node:assert/strict';
import { absorptionOf, findSwings } from '../scripts/volatility-episodes.mts';
import type { AbsorptionGroup } from '../src/shared/absorption.ts';

/** Candles a tenth either side of each close. */
const candles = (closes: number[]): { h: number[]; l: number[] } => ({ h: closes.map(c => c + 0.1), l: closes.map(c => c - 0.1) });
/** Volatile minutes: `up` at the given indices, `down` at others, null elsewhere. */
function volatileAt(n: number, up: number[], down: number[]): (boolean | null)[] {
  const out = new Array<boolean | null>(n).fill(null);
  for (const i of up) out[i] = true;
  for (const i of down) out[i] = false;
  return out;
}

test('a flush and its bounce are two moves, each measured from the last minute at its turning point to where it ends', () => {
  const closes = [...new Array<number>(10).fill(100), 99, 98, 97, 96, 95, 96, 97, 98, 99, ...new Array<number>(21).fill(99.5)];
  const { h, l } = candles(closes);
  const moves = findSwings(volatileAt(closes.length, [13, 14, 15, 16, 17], [8, 9, 10, 11, 12]), h, l);
  assert.deepEqual(moves.map(m => [m.up, m.start, m.end, m.volatileMinutes]), [[false, 9, 14, 5], [true, 14, 19, 5]]);
  assert.ok(Math.abs(moves[0]!.move - 5.2) < 1e-9 && Math.abs(moves[1]!.move - 4.7) < 1e-9);
});

test('volatile minutes of one direction further apart than the gap are one move when their swings overlap', () => {
  const closes = [...new Array<number>(5).fill(100), ...Array.from({ length: 36 }, (_, k) => 100 - 0.1 * (k + 1)), ...new Array<number>(10).fill(96.4)];
  const { h, l } = candles(closes);
  const moves = findSwings(volatileAt(closes.length, [], [5, 6, 7, 25, 26, 27]), h, l);
  assert.deepEqual(moves.map(m => [m.up, m.start, m.end, m.first, m.last, m.volatileMinutes]), [[false, 4, 40, 5, 27, 6]]);
});

test('absorption is marked as the page marks it: the threshold comes from the 30 minutes up to this one, each group counts by its aggressor side', () => {
  const MINUTE = 60_000, t = 100 * MINUTE;
  // In the window: mean $50K, sd $15K, so the threshold is 50K + 10 x 15K = $200K. The minute exactly 30 minutes back is outside it; counted,
  // it would lift the threshold past every group.
  const minutes = [{ t: t - 30 * MINUTE, n: 1_000, mean: 1e9, m2: 0 }, { t, n: 4, mean: 50_000, m2: 4 * 15_000 ** 2 }];
  const group = (side: 'buy' | 'sell', at: number, steps: [number, number, number][]): AbsorptionGroup =>
    ({ id: 'binance:BTCUSDT', side, price: 82_000, t0: t + at, steps: steps.map(([credit, usd, fills]) => [credit, usd, fills, t + at, t + at + fills]) });
  const groups = [
    group('buy', 1_000, [[300_000, 300_000, 1], [100_000, 420_000, 3]]),
    group('sell', 2_000, [[150_000, 150_000, 1]]),
    group('sell', 3_000, [[260_000, 260_000, 2], [210_000, 470_000, 3], [50_000, 520_000, 4]]),
  ];
  assert.deepEqual(absorptionOf(groups, minutes, t), [1, 300_000, 1, 470_000]);
  assert.equal(absorptionOf(groups, minutes.slice(0, 1), t), null);
});
