import test from 'node:test';
import assert from 'node:assert/strict';
import { findSwings } from '../scripts/sharp-episodes.mts';

/** Candles a tenth either side of each close. */
const candles = (closes: number[]): { h: number[]; l: number[] } => ({ h: closes.map(c => c + 0.1), l: closes.map(c => c - 0.1) });
/** Sharp minutes: `up` at the given indices, `down` at others, null elsewhere. */
function sharpAt(n: number, up: number[], down: number[]): (boolean | null)[] {
  const out = new Array<boolean | null>(n).fill(null);
  for (const i of up) out[i] = true;
  for (const i of down) out[i] = false;
  return out;
}

test('a flush and its bounce are two moves, each measured from the last minute at its turning point to where it ends', () => {
  const closes = [...new Array<number>(10).fill(100), 99, 98, 97, 96, 95, 96, 97, 98, 99, ...new Array<number>(21).fill(99.5)];
  const { h, l } = candles(closes);
  const moves = findSwings(sharpAt(closes.length, [13, 14, 15, 16, 17], [8, 9, 10, 11, 12]), h, l);
  assert.deepEqual(moves.map(m => [m.up, m.start, m.end, m.sharp]), [[false, 9, 14, 5], [true, 14, 19, 5]]);
  assert.ok(Math.abs(moves[0]!.move - 5.2) < 1e-9 && Math.abs(moves[1]!.move - 4.7) < 1e-9);
});

test('sharp minutes of one direction further apart than the gap are one move when their swings overlap', () => {
  const closes = [...new Array<number>(5).fill(100), ...Array.from({ length: 36 }, (_, k) => 100 - 0.1 * (k + 1)), ...new Array<number>(10).fill(96.4)];
  const { h, l } = candles(closes);
  const moves = findSwings(sharpAt(closes.length, [], [5, 6, 7, 25, 26, 27]), h, l);
  assert.deepEqual(moves.map(m => [m.up, m.start, m.end, m.first, m.last, m.sharp]), [[false, 4, 40, 5, 27, 6]]);
});
