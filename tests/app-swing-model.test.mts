import test from 'node:test';
import assert from 'node:assert/strict';
import { SWING_FAST_LENGTH, SWING_HIGH, SWING_LOW, SWING_SLOW_AVERAGE, SWING_SLOW_LENGTH, VALUE_CHEAP, VALUE_HOT, VALUE_LENGTH, VALUE_SMOOTH, swingRows, swingZone, valueZone, type SwingCandle } from '../src/app/swing/model.ts';

const candle = (t: number, o: number, c: number, wick = 0.2): SwingCandle => ({ t, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c });
/** A walk of `n` candles from 100, each moving by `step(i)`. */
function walk(n: number, step: (i: number) => number): SwingCandle[] {
  const out: SwingCandle[] = []; let p = 100;
  for (let i = 0; i < n; i++) { const next = p + step(i); out.push(candle(i * 60_000, p, next)); p = next; }
  return out;
}

test('a reading is null until the candles before it are enough to make it, and only then', () => {
  const rows = swingRows(walk(80, i => Math.sin(i / 3)));
  const firstFast = SWING_FAST_LENGTH - 1, firstSlow = SWING_SLOW_LENGTH + SWING_SLOW_AVERAGE - 2, firstValue = VALUE_LENGTH + VALUE_SMOOTH - 2;
  assert.equal(rows[firstFast - 1]!.fast, null); assert.notEqual(rows[firstFast]!.fast, null);
  assert.equal(rows[firstSlow - 1]!.slow, null); assert.notEqual(rows[firstSlow]!.slow, null);
  assert.equal(rows[firstValue - 1]!.value, null); assert.notEqual(rows[firstValue]!.value, null);
  assert.equal(swingZone(rows[firstSlow - 1]!), null, 'no zone without both lines');
});

test('a steady climb pins both lines at the ceiling with the trend up, and the reading runs hot; a steady fall the other way', () => {
  const up = swingRows(walk(160, () => 1)).at(-1)!, down = swingRows(walk(160, () => -1)).at(-1)!;
  assert.equal(up.fast, 100); assert.equal(up.slow, 100); assert.equal(up.up, true); assert.equal(swingZone(up), 'ceiling');
  assert.ok(up.value! < VALUE_HOT, `hot: ${up.value}`); assert.equal(valueZone(up.value!), 'hot');
  assert.equal(down.fast, 0); assert.equal(down.slow, 0); assert.equal(down.up, false); assert.equal(swingZone(down), 'floor');
  assert.ok(down.value! >= VALUE_CHEAP, `cheap: ${down.value}`); assert.equal(valueZone(down.value!), 'cheap');
});

test('a range with no width reads the middle, never a division by zero', () => {
  const flat = Array.from({ length: 140 }, (_, i) => ({ t: i, o: 50, h: 50, l: 50, c: 50 }));
  const row = swingRows(flat).at(-1)!;
  assert.equal(row.fast, 50); assert.equal(row.slow, 50); assert.equal(row.value, 50); assert.equal(row.up, false);
});

test('after a climb, a fall takes the bar from the ceiling to the floor, turning it red on the way', () => {
  const rows = swingRows(walk(170, i => i < 120 ? 1 : -2));
  assert.equal(swingZone(rows[119]!), 'ceiling');
  const firstRed = rows.findIndex((r, i) => i > 120 && r.up === false), firstFloor = rows.findIndex((r, i) => i > 120 && swingZone(r) === 'floor');
  assert.ok(firstRed > 120 && firstRed < firstFloor, `red at ${firstRed}, floor at ${firstFloor}`);
  assert.equal(swingZone(rows.at(-1)!), 'floor');
});

test('zones: the bar reaching into the floor or the ceiling counts, and the cheap/hot edges', () => {
  const row = (fast: number, slow: number) => ({ t: 0, fast, slow, up: true, value: 30 });
  assert.equal(swingZone(row(SWING_LOW, 40)), 'floor');
  assert.equal(swingZone(row(SWING_LOW + 0.1, 40)), null);
  assert.equal(swingZone(row(70, SWING_HIGH)), 'ceiling');
  assert.equal(swingZone(row(10, SWING_HIGH)), 'floor', 'a bar reaching both reads the floor');
  assert.deepEqual([VALUE_CHEAP, VALUE_CHEAP - 0.1, VALUE_HOT, VALUE_HOT - 0.1].map(valueZone), ['cheap', 'neutral', 'neutral', 'hot']);
});
