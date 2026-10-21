import test from 'node:test';
import assert from 'node:assert/strict';
import { TOF_MIN_CANDLES, TOF_WINDOW, bandOf, tofByPrice, tofLevels, tofOf, tofScores, type TofCandle } from '../src/app/tof/model.ts';

test('bands: a toxic burst above 2, elevated from 1, normal within 1, quiet under -1', () => {
  assert.deepEqual([2.01, 2, 1, 0.99, -1, -1.01, null, Number.NaN].map(bandOf), ['toxic', 'elevated', 'elevated', 'normal', 'normal', 'quiet', null, null]);
});

test('a candle\'s reading is its volume weighted by the square root of its range over its open', () => {
  assert.equal(tofOf(1_000_000, { t: 0, o: 100, h: 104, l: 100 }), 200_000);
  assert.equal(tofOf(0, { t: 0, o: 100, h: 104, l: 100 }), null, 'no volume');
  assert.equal(tofOf(5, { t: 0, o: 0, h: 1, l: 0 }), null, 'no open');
  assert.equal(tofOf(5, { t: 0, o: 100, h: 99, l: 100 }), null, 'high under low');
});

test('z is against the readings before it only, over at most the window, and needs enough of them', () => {
  const values = Array.from({ length: TOF_WINDOW + 60 }, (_, i) => i % 7 === 3 ? null : 1_000 * Math.exp(Math.sin(i * 1.3)));
  values[TOF_WINDOW + 40] = 1_000 * Math.exp(5);
  const { z, usual } = tofScores(values);
  // Brute force for one candle past a full window.
  const i = TOF_WINDOW + 40, before = values.slice(i - TOF_WINDOW, i).flatMap(v => v ? [Math.log(v)] : []);
  const m = before.reduce((a, b) => a + b, 0) / before.length, sd = Math.sqrt(before.reduce((a, b) => a + (b - m) ** 2, 0) / before.length);
  assert.ok(Math.abs(z[i]! - (Math.log(values[i]!) - m) / sd) < 1e-9);
  assert.ok(Math.abs(usual[i]! - Math.exp(m)) < 1e-9);
  assert.ok(z[i]! > 2, 'the burst stands out');
  assert.equal(z[TOF_MIN_CANDLES - 1], null, 'too few readings before it');
  assert.equal(z[3], null);
  assert.equal(z[TOF_WINDOW + 2], null, 'no reading of its own (every seventh from the fourth is missing)');
  assert.notEqual(usual[TOF_WINDOW + 2], null, 'but the usual is known');
});

test('a level is a strong candle\'s open, taken by the first later candle that trades through it', () => {
  const c = (t: number, o: number, h: number, l: number): TofCandle => ({ t, o, h, l });
  const candles = [c(0, 100, 101, 99), c(1, 101, 106, 101), c(2, 105, 108, 104), c(3, 107, 107, 100.5), c(4, 103, 104, 102)];
  const tof = [10, 50, 20, 40, 5], z = [0.5, 2.4, 1.2, 1.5, null];
  const levels = tofLevels(candles, tof, z, 1);
  assert.deepEqual(levels.map(l => [l.t, l.price, l.taken]), [[1, 101, 3], [2, 105, 3], [3, 107, null]], 'candle 3 trades down through 101 and 105; nothing comes back to 107');
  assert.deepEqual(tofLevels(candles, tof, z, 2).map(l => l.t), [1]);
  assert.deepEqual(tofByPrice([...levels, { t: 5, price: 107.4, tof: 3, z: 1, taken: null }], 1), [{ price: 107, tof: 43 }], 'untapped levels only, added up per row');
});
