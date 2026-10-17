import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL, WAVE_SPEED, pulseFor, substepsFor } from '../src/app/glass/waves.ts';

test('the wave field steps often enough to stay stable at its speed, and never more than it must', () => {
  const courant = (dt: number): number => WAVE_SPEED / CELL / 1000 * dt / substepsFor(dt);
  for (const dt of [4, 8, 16.7, 33, 50]) assert.ok(courant(dt) <= 0.6 + 1e-9, `a frame of ${dt} ms`);
  assert.equal(substepsFor(16.7), Math.ceil(16.7 / (0.6 / (WAVE_SPEED / CELL / 1000))), 'the fewest that hold it');
  assert.equal(substepsFor(1000), substepsFor(50), 'a long pause steps as a short one, not a second at once');
});

test('a larger order makes a taller and a wider pulse, as a larger stone does, within bounds', () => {
  const small = pulseFor(25_000, 25_000), mid = pulseFor(250_000, 25_000), big = pulseFor(2_500_000, 25_000), huge = pulseFor(1e12, 25_000);
  assert.ok(small.amp < mid.amp && mid.amp < big.amp, 'taller');
  assert.ok(small.width < mid.width && mid.width < big.width, 'wider');
  assert.ok(huge.amp <= 1.6, 'and never past the cap');
  assert.deepEqual(pulseFor(-250_000, 25_000), mid, 'a sell as a buy');
});
