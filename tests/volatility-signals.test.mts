import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterOf, movedOf, signalsOf, type SignalSource } from '../src/shared/volatility/signals.ts';
import { VolatilityWatch } from '../src/server/v2/volatility.mts';

const MINUTE = 60_000, T = Date.UTC(2026, 9, 20, 12, 0);
const verdict = (score: number, scoreConfidence: number, direction: 'up' | 'down', underway: boolean | null | undefined) =>
  ({ score, scoreConfidence, direction, directionP: 0.7, ...(underway === undefined ? {} : { underway }) });
const call = (direction: 'up' | 'down', called = true) => ({ call: called, direction, score: direction === 'up' ? 0.5 : -0.5, agree: 2, against: 0, triggers: ['highlight'] });

test('a minute names a side when Jev scores from 1.5 with confidence, and when the confluence calls', () => {
  const both: SignalSource = { features: { t: T, price: 100_000 }, verdict: verdict(2.6, 0.6, 'up', false), confluence: call('down') };
  assert.deepEqual(signalsOf(both), [
    { kind: 'jev', t: T, price: 100_000, side: 'long', jev: { score: 2.6, confidence: 0.6, p: 0.7, underway: false } },
    { kind: 'confluence', t: T, price: 100_000, side: 'short', confluence: { score: -0.5, agree: 2, against: 0, triggers: ['highlight'] } },
  ]);
  assert.deepEqual(signalsOf({ features: { t: T, price: 100_000 }, verdict: verdict(3, 0.4, 'up', false) }), [], 'Jev unsure of its score');
  assert.deepEqual(signalsOf({ features: { t: T, price: 100_000 }, verdict: verdict(1.4, 0.9, 'up', false) }), [], 'a score under 1.5');
  assert.deepEqual(signalsOf({ features: { t: T, price: 100_000 }, confluence: call('up', false) }), [], 'agreement without a call');
  // A row logged before verdicts carried `underway` takes the features' own when they have it, and is unknown otherwise.
  assert.equal(signalsOf({ features: { t: T, price: 100_000, move: { underway: true } }, verdict: verdict(2, 0.6, 'down', undefined) })[0]!.jev!.underway, true);
  assert.equal(signalsOf({ features: { t: T, price: 100_000 }, verdict: verdict(2, 0.6, 'down', undefined) })[0]!.jev!.underway, null);
});

test('what price did after a signal is in basis points its way, and unknown until the minutes are in', () => {
  // Price rises 1 bp a minute for 10 minutes, then falls 1 bp a minute.
  const prices = new Map<number, number>();
  for (let m = 0; m <= 30; m++) prices.set(T + m * MINUTE, 100_000 * Math.exp((m <= 10 ? m : 20 - m) * 1e-4));
  const priceAt = (t: number) => prices.get(t);
  assert.deepEqual(afterOf({ t: T, price: 100_000, side: 'long' }, priceAt), { r5: 5, r15: 5, r30: -10, best15: 10, worst15: 1 });
  assert.deepEqual(afterOf({ t: T, price: 100_000, side: 'short' }, priceAt), { r5: -5, r15: -5, r30: 10, best15: -1, worst15: -10 });
  assert.deepEqual(afterOf({ t: T + 20 * MINUTE, price: prices.get(T + 20 * MINUTE)!, side: 'long' }, priceAt), { r5: -5, r15: null, r30: null, best15: null, worst15: null }, 'too recent');
  prices.delete(T + 7 * MINUTE);
  assert.deepEqual(afterOf({ t: T, price: 100_000, side: 'long' }, priceAt), { r5: 5, r15: 5, r30: -10, best15: null, worst15: null }, 'a gap leaves the extremes unknown');
});

test('a minute is already moving when the last 15 minutes span two of the day\'s 15-minute standard deviations', () => {
  const prices = new Map<number, number>();
  let x = 0;
  for (let m = 1_500; m >= 16; m--) { x += 1e-4 * Math.sin(m * 12.9898) * Math.cos(m * 4.1414); prices.set(T - m * MINUTE, 100_000 * Math.exp(x)); }
  const last = (shape: (k: number) => number) => { for (let k = 15; k >= 0; k--) prices.set(T - k * MINUTE, 100_000 * Math.exp(x + shape(15 - k))); return movedOf(T, t => prices.get(t)); };
  assert.equal(last(() => 0), false, 'flat');
  assert.equal(last(k => k * 5e-4), true, 'a 75 bp run');
  assert.equal(movedOf(T - 1_480 * MINUTE, t => prices.get(t)), null, 'without a day of returns');
});

test('the watch reads its signals back from the log, fills in whether price was already moving, and adds what came after', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volatility-signals-'));
  const rows: SignalSource[] = [];
  for (let m = -1_500; m <= 30; m++) rows.push({ features: { t: T + m * MINUTE, price: 100_000 * Math.exp(Math.sin(m / 7) * 2e-4 + (m > 0 && m <= 10 ? m * 1e-4 : m > 10 ? 1e-3 : 0)) } });
  const at = (m: number) => rows.find(r => r.features.t === T + m * MINUTE)!;
  Object.assign(at(0), { verdict: verdict(2.5, 0.8, 'up', undefined) });
  Object.assign(at(20), { verdict: verdict(3.4, 0.9, 'down', true), confluence: call('down') });
  fs.writeFileSync(path.join(dir, 'volatility-log.1.jsonl'), rows.slice(0, 1_000).map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'volatility-log.jsonl'), rows.slice(1_000).map(r => JSON.stringify(r)).join('\n') + '\n{"features":');
  const watch = new VolatilityWatch({ dir, read: () => null, clock: () => T + 31 * MINUTE });
  await watch.history;
  const { signals } = watch.signals(T - MINUTE, T + 31 * MINUTE);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(signals.map(s => [s.kind, (s.t - T) / MINUTE, s.side]), [['jev', 0, 'long'], ['confluence', 20, 'short'], ['jev', 20, 'short']]);
  assert.equal(signals[0]!.jev!.underway, false, 'filled in from the prices: they were quiet before minute 0');
  assert.equal(signals[2]!.jev!.underway, true, 'as logged');
  assert.ok(signals[0]!.after.r5! > 0 && signals[0]!.after.r15 !== null, `rose after the long: ${JSON.stringify(signals[0]!.after)}`);
  assert.equal(signals[1]!.after.r15, null, 'the minutes after the short are not in yet');
  assert.deepEqual(watch.signals(T + 21 * MINUTE, T + 31 * MINUTE).signals, [], 'the window is [from, to)');
});

test('the watch answers the volatility-ahead warnings that ended in the window, worked out from the reference perpetual once a minute', () => {
  // 1,500 minutes of a wavy price, flat over bars 197 to 200, and bar 200 trading twelve times as much.
  const n = 1_500, buy = new Float64Array(n), sell = new Float64Array(n), px = new Float64Array(n);
  for (let i = 0; i < n; i++) { buy[i] = 4e5 * (1 + 0.3 * Math.sin(i * 0.37)); sell[i] = 4e5 * (1 + 0.3 * Math.cos(i * 0.53)); px[i] = 100_000 * (1 + 0.001 * Math.sin(i * 0.21)); }
  for (let i = 985; i < 1_005; i++) px[i] = px[985]!;
  for (let i = 1_000; i < 1_005; i++) { buy[i]! *= 12; sell[i]! *= 12; }
  const asked: [number, number][] = [];
  const watch = new VolatilityWatch({ dir: null, read: () => null, clock: () => T + n * MINUTE + 30_000, minutes: (from, to) => { asked.push([from, to]); return { t0: T, buy, sell, px }; } });
  assert.deepEqual(watch.signals(T, T + n * MINUTE).ahead.map(w => [w.tf, (w.t - T) / MINUTE]), [[5, 1_005]]);
  assert.deepEqual(watch.signals(T + 1_005 * MINUTE + 1, T + n * MINUTE).ahead, [], 'the window is [from, to)');
  assert.deepEqual(asked, [[T + n * MINUTE - 7 * 24 * 60 * MINUTE, T + n * MINUTE]], 'the week the flow store keeps, read once in the minute');
  assert.deepEqual(new VolatilityWatch({ dir: null, read: () => null }).signals(0, Infinity).ahead, [], 'none without the minutes');
});
