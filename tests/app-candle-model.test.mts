import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_W, CANDLE_DEFAULTS, COVER_SLACK_MS, FLASH_MS, MAX_FLASHES, MIN_SPAN, RAIL_W, ageTicks, candleLayout, countdownText, coveredMarkets, flashRadius, flashStrength,
  flashes, pocIndex, priceAt, priceSpan, railCells, readCandleSettings, rowStepFor, splitRow, trailX, yOf, type Arrival,
} from '../src/app/candle/model.ts';
import type { CoverageAnswer } from '../src/shared/coverage.ts';

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

test('a market is judged only when its trades were recorded, live or recovered, from the open of the bar to the answer without a break', () => {
  const bar = 1_000 * 300_000, asOf = bar + 150_000;
  const answer = (spans: Record<string, [number, number][]>, at = asOf): CoverageAnswer => ({ metric: 'trades', from: bar - 300_000, to: bar + 180_000, asOf: at,
    instruments: Object.entries(spans).map(([id, s]) => ({ id, spans: s, recovered: [], seconds: [], held: [] })) });
  const all = ['a', 'b', 'c', 'd'];
  const got = coveredMarkets(answer({
    a: [[bar - 60_000, asOf]],
    b: [[bar - 60_000, bar + 30_000], [bar + 50_000, asOf]],                 // the phone was away for 20 s inside the bar
    c: [[bar + 10_000, asOf]],                                               // recorded from inside the bar only
    d: [[bar - 60_000, bar + 20_000], [bar + 20_000, asOf - COVER_SLACK_MS]], // a recovered stretch joined to the live one, up to the beat
  }), all, bar);
  assert.deepEqual([...got].sort(), ['a', 'd']);
  assert.equal(coveredMarkets(null, all, bar).size, 0, 'no answer (a source that cannot say): nothing is judged');
  assert.equal(coveredMarkets(answer({ a: [[bar - 60_000, bar - 1_000]] }, bar - 1_000), all, bar).size, 0, 'an answer from before the bar opened');
  assert.equal(coveredMarkets(answer({ a: [[bar + 200, bar + 400]] }, bar + 500), all, bar).has('a'), false, 'in the bar\'s first second a market counts only if it was recorded at its open');
  assert.equal(coveredMarkets(answer({ a: [[bar - 5_000, bar + 400]] }, bar + 500), all, bar).has('a'), true);
  assert.equal(coveredMarkets(answer({ z: [[bar - 60_000, asOf]] }), all, bar).size, 0, 'a market not selected does not count');
});

test('a row is split into what the covered markets did, judged, and what the others did, observed', () => {
  const covered = new Set(['a']);
  assert.deepEqual(splitRow(30, 20, [['a', 10, 5], ['b', 20, 15]], covered, ['a', 'b']), { buy: 10, sell: 5, partBuy: 20, partSell: 15 });
  assert.deepEqual(splitRow(30, 20, [['b', 30, 20]], covered, ['a', 'b']), { buy: 0, sell: 0, partBuy: 30, partSell: 20 });
  assert.deepEqual(splitRow(30, 20, undefined, covered, ['a']), { buy: 30, sell: 20, partBuy: 0, partSell: 0 }, 'one market: the row is all its own');
  assert.deepEqual(splitRow(30, 20, undefined, covered, ['a', 'b']), { buy: 0, sell: 0, partBuy: 30, partSell: 20 }, 'several markets with no parts cannot be judged');
  // A partial market selling 900 against a covered one buying 100: the judgement sees the covered 100 bought, never a buy imbalance of the whole row.
  assert.deepEqual(splitRow(100, 900, [['a', 100, 0], ['b', 0, 900]], covered, ['a', 'b']), { buy: 100, sell: 0, partBuy: 0, partSell: 900 });
});

test('the countdown and the point of control', () => {
  assert.equal(countdownText(134_000), '2:14'); assert.equal(countdownText(3_725_000), '1:02:05'); assert.equal(countdownText(-5), '0:00');
  assert.equal(pocIndex([[1, 2, 3], [2, 10, 1], [3, 0, 0]]), 1); assert.equal(pocIndex([]), -1);
});
