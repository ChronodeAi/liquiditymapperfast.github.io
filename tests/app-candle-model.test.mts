import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_W, CANDLE_DEFAULTS, FLASH_MS, MAX_FLASHES, MIN_SPAN, RAIL_W, ageTicks, barComplete, candleLayout, countdownText, flashRadius, flashStrength,
  flashes, pocIndex, priceAt, priceSpan, railCells, readCandleSettings, rowStepFor, trailX, yOf, type Arrival,
} from '../src/app/candle/model.ts';

test('saved settings are read field by field, anything that does not check out falls back to its default', () => {
  assert.deepEqual(readCandleSettings(null), CANDLE_DEFAULTS);
  assert.deepEqual(readCandleSettings({ style: 'beads', trailMs: 30_000, tf: '1m', glass: false }), { style: 'beads', trailMs: 30_000, tf: '1m', glass: false });
  assert.deepEqual(readCandleSettings({ style: 'neon', trailMs: 45_000, tf: '4h', glass: 'yes' }), CANDLE_DEFAULTS);
  assert.equal(CANDLE_DEFAULTS.tf, '5m', 'the agreed default: a 5-minute candle, not the map\'s hourly one');
});

test('the columns run left to right without overlap and the trail ends at the rail', () => {
  for (const [w, h] of [[390, 700], [360, 520], [844, 300]] as const) {
    const l = candleLayout(w, h);
    assert.ok(l.bidX0 < l.bidX1 && l.bidX1 < l.candleX0 && l.candleX0 < l.candleX1 && l.candleX1 < l.askX0 && l.askX0 < l.askX1, `ordered at ${w}`);
    assert.ok(l.askX1 <= l.railX0 && l.railX1 === l.axisX0 && l.axisX1 === w, `the rail and the axis close the row at ${w}`);
    assert.equal(l.axisX1 - l.axisX0, AXIS_W); assert.equal(l.railX1 - l.railX0, RAIL_W);
    assert.ok(l.candleX1 - l.candleX0 >= 96, 'room for two footprint numbers a row');
    assert.equal(l.trailX1, l.railX0, 'now is the rail');
    assert.ok(l.plotY1 < h, 'the age ruler has its strip below the plot');
  }
});

test('the prices shown hold the candle and the price, at least a minimum span, and keep the price off the edges', () => {
  const s = priceSpan(81_300, 81_400, 81_350, 0, 600);
  assert.ok(s.p0 < 81_300 && s.p1 > 81_400);
  const quiet = priceSpan(81_349, 81_351, 81_350, 0, 600);
  assert.ok(quiet.p1 - quiet.p0 >= 81_350 * MIN_SPAN - 1e-6, 'a quiet bar is not blown up');
  const panned = priceSpan(81_300, 81_400, 81_350, 0, 600, 1, 10_000);
  const y = yOf(panned, 81_350);
  assert.ok(y >= 59.99 && y <= 540.01, 'a pan cannot push the price past the middle four fifths');
  assert.ok(Math.abs(priceAt(s, yOf(s, 81_333)) - 81_333) < 1e-6, 'yOf and priceAt invert each other');
  const zoomed = priceSpan(81_300, 81_400, 81_350, 0, 600, 0.5);
  assert.ok(zoomed.p1 - zoomed.p0 < s.p1 - s.p0, 'a pinch apart shows fewer prices');
});

test('the footprint row step doubles the recorded one until a row is tall enough, and waits for the recorded step', () => {
  const s = { p0: 81_000, p1: 81_300, y0: 0, y1: 600 };
  assert.equal(rowStepFor(0, s), 0);
  const step = rowStepFor(0.5, s, 16);
  assert.ok(step * 2 >= 16 && step / 0.5 === 2 ** Math.round(Math.log2(step / 0.5)), 'a power of two times the recorded step');
  assert.ok(step * 600 / 300 >= 16 && (step / 2) * 600 / 300 < 16, 'the smallest that reaches 16 px');
});

test('the rail adds arrivals up by row, and the largest flashes, at most a handful, fading with a flashbulb\'s envelope', () => {
  const at = 10_000, a = (price: number, usd: number, dt = 0, inst = 0): Arrival => ({ price, usd, at: at + dt, inst });
  const cells = railCells([a(100.2, 5_000), a(100.7, -30_000, 10, 3), a(101.1, 60_000, 20, 1), a(99.9, 1_000, -5_000)], 1, at - 1000, at + 100);
  assert.equal(cells.length, 2, 'an arrival outside the stretch is left out');
  const row100 = cells.find(c => c.bin === 100)!;
  assert.deepEqual([row100.buy, row100.sell, row100.count, row100.largest, row100.largestInst], [5_000, 30_000, 2, 30_000, 3], 'the largest names its market');
  const orders = [a(100.2, 5_000), a(100.7, -30_000, 10, 3), a(101.1, 60_000, 20, 1), a(99.9, 1_000, -5_000)];
  const lit = flashes(orders, 1, 25_000, at + 30);
  assert.deepEqual(lit.map(c => c.bin), [101, 100], 'largest first');
  assert.ok(lit[0]!.k > 0.9 && lit[0]!.k <= 1);
  assert.deepEqual([lit[1]!.buy, lit[1]!.sell], [0, 30_000], 'a flash counts its large orders alone');
  assert.deepEqual(flashes(orders, 1, 25_000, at + 15 + FLASH_MS).map(x => x.bin), [101], 'a flash is gone once its time has passed, a later one still lit');
  // A small order arriving later in the same row does not light a large one's flash again.
  assert.equal(flashes([a(100.5, 1_000_000), a(100.4, 100, FLASH_MS - 20)], 1, 25_000, at + FLASH_MS + 10).length, 0, 'the large order\'s flash ends on time');
  assert.equal(flashes(Array.from({ length: 20 }, (_, i) => a(100 + i, 50_000 + i)), 1, 25_000, at).length, MAX_FLASHES);
  assert.equal(flashStrength(0), 1); assert.equal(flashStrength(FLASH_MS), 0);
  assert.ok(flashStrength(FLASH_MS / 4) > flashStrength(FLASH_MS / 2) && flashStrength(FLASH_MS / 2) > 0, 'falls off and does not come back');
  assert.equal(flashRadius(10, 25_000, 2e6), 3); assert.equal(flashRadius(5e6, 25_000, 2e6), 9);
  assert.ok(flashRadius(200_000, 25_000, 2e6) > flashRadius(50_000, 25_000, 2e6));
});

test('the trail and its ruler: now at the rail, the window at the left edge, a mark every quarter', () => {
  const l = candleLayout(390, 700);
  assert.equal(trailX(l, 0, 60_000), l.trailX1);
  assert.equal(trailX(l, 60_000, 60_000), l.trailX0);
  assert.equal(trailX(l, 90_000, 60_000), l.trailX0, 'clamped');
  assert.deepEqual(ageTicks(60_000).map(t => t.seconds), [0, 15, 30, 45, 60]);
});

test('a bar is judged only when the recording reaches back to its open and no minute is missing', () => {
  const bar = 1_000 * 300_000, now = bar + 150_000;
  assert.equal(barComplete(3, bar, now, bar - 60_000), true);
  assert.equal(barComplete(2, bar, now, bar - 60_000), false, 'thirty seconds into the third minute, two minutes is one missing');
  assert.equal(barComplete(2, bar, bar + 125_000, bar - 60_000), true, 'in the first seconds of a minute its trades may not be in the last answer yet');
  assert.equal(barComplete(1, bar, now, bar - 60_000), false, 'a minute missing: the phone was away');
  assert.equal(barComplete(3, bar, now, bar - 60_000, [{ from: bar + 30_000, to: bar + 50_000 }]), false, 'the page was hidden, or a book was off the map, inside the bar');
  assert.equal(barComplete(3, bar, now, bar - 60_000, [{ from: bar - 90_000, to: bar - 30_000 }]), true, 'a gap before the bar does not count');
  assert.equal(barComplete(3, bar, now, bar + 10_000), false, 'the recording began inside the bar');
  assert.equal(barComplete(undefined, bar, now, bar - 60_000), false);
  assert.equal(barComplete(3, bar, now, 0), false, 'unknown start');
});

test('the countdown and the point of control', () => {
  assert.equal(countdownText(134_000), '2:14'); assert.equal(countdownText(3_725_000), '1:02:05'); assert.equal(countdownText(-5), '0:00');
  assert.equal(pocIndex([[1, 2, 3], [2, 10, 1], [3, 0, 0]]), 1); assert.equal(pocIndex([]), -1);
});
