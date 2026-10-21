import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_DEFAULTS, SignalBook, readSignals, signalLines, summaryOf, type SignalSettings } from '../src/app/signals.ts';
import { getSignals } from '../src/app/net.ts';
import { WARN_MIN_SCORE } from '../src/shared/volatility/jev.ts';
import { SIGNAL_MIN_SCORE, type Signal, type SignalAfter } from '../src/shared/volatility/signals.ts';

const MIN = 60_000;
const none: SignalAfter = { r5: null, r15: null, r30: null, best15: null, worst15: null };
const jev = (t: number, score: number, underway: boolean | null, after: SignalAfter = none): Signal =>
  ({ kind: 'jev', t, price: 100, side: 'long', jev: { score, confidence: 0.7, p: 0.62, underway }, after });
const call = (t: number, after: SignalAfter = none): Signal =>
  ({ kind: 'confluence', t, price: 100, side: 'short', confluence: { score: -0.4, agree: 3, against: 1, triggers: ['oi', 'cvd'] }, after });
const all: SignalSettings = { on: true, jev: true, confluence: true, minScore: SIGNAL_MIN_SCORE, duringMoves: true };

test('readSignals: defaults, bounds, halves, junk', () => {
  assert.deepEqual(readSignals(undefined), SIGNAL_DEFAULTS);
  assert.deepEqual(SIGNAL_DEFAULTS, { on: false, jev: true, confluence: true, minScore: WARN_MIN_SCORE, duringMoves: false });
  assert.deepEqual(readSignals('junk'), SIGNAL_DEFAULTS);
  assert.equal(readSignals({ minScore: 0 }).minScore, SIGNAL_MIN_SCORE);
  assert.equal(readSignals({ minScore: 9 }).minScore, 4);
  assert.equal(readSignals({ minScore: 2.7 }).minScore, 2.5);
  assert.equal(readSignals({ minScore: 3.3 }).minScore, 3.5);
  assert.equal(readSignals({ minScore: Number.NaN }).minScore, WARN_MIN_SCORE);
  assert.equal(readSignals({ minScore: '3' }).minScore, WARN_MIN_SCORE);
  assert.deepEqual(readSignals({ on: true, jev: false, confluence: 1, duringMoves: true }), { on: true, jev: false, confluence: true, minScore: WARN_MIN_SCORE, duringMoves: true });
});

test('the book merges by kind and minute, keeps time order, and an answer again replaces', () => {
  const book = new SignalBook();
  book.add([jev(3 * MIN, 3, false), call(MIN)]);
  book.add([jev(2 * MIN, 3, false), call(MIN), jev(3 * MIN, 3, false)]);
  assert.deepEqual(book.items.map(s => `${s.kind}:${s.t / MIN}`), ['confluence:1', 'jev:2', 'jev:3']);
  const v = book.version;
  book.add([jev(3 * MIN, 3, false)]);
  assert.equal(book.version, v, 'the same again changes nothing');
  book.add([jev(3 * MIN, 3, false, { ...none, r5: 4 })]);
  assert.equal(book.items.length, 3);
  assert.equal(book.items[2]!.after.r5, 4, 'results fill in');
  const small = new SignalBook(2);
  small.add([jev(MIN, 3, false), jev(2 * MIN, 3, false), jev(3 * MIN, 3, false)], { from: 2 * MIN, to: 4 * MIN });
  assert.deepEqual(small.items.map(s => s.t / MIN), [2, 3], 'the oldest outside the window goes first');
});

test('visible: kinds by their switches, the minimum score, moves already under way', () => {
  const book = new SignalBook();
  book.add([jev(MIN, 2, false), jev(2 * MIN, 3, true), jev(3 * MIN, 3, null), jev(4 * MIN, 3, false), call(5 * MIN), jev(9 * MIN, 4, false)]);
  const at = (s: SignalSettings): string[] => book.visible(0, 8 * MIN, s).map(x => `${x.kind}:${x.t / MIN}`);
  assert.deepEqual(at(all), ['jev:1', 'jev:2', 'jev:3', 'jev:4', 'confluence:5'], 'the window is [from, to)');
  assert.deepEqual(at({ ...all, minScore: 2.5 }), ['jev:2', 'jev:3', 'jev:4', 'confluence:5']);
  assert.deepEqual(at({ ...all, duringMoves: false }), ['jev:1', 'jev:4', 'confluence:5'], 'under way or unknown is hidden');
  assert.deepEqual(at({ ...all, jev: false }), ['confluence:5']);
  assert.deepEqual(at({ ...all, confluence: false, minScore: 4 }), []);
});

test('signalLines: a Jev warning, a confluence call, and results not known yet', () => {
  const j = signalLines(jev(MIN, 3, true, { r5: 12.3, r15: -4, r30: null, best15: 20, worst15: -6.5 }));
  assert.equal(j[0]!.text, 'Long: Jev warning');
  const value = (lines: ReturnType<typeof signalLines>, label: string): string | undefined => lines.find(l => l.label === label)?.text;
  assert.equal(value(j, 'Jev score'), '3.0 / 4');
  assert.equal(value(j, 'Confidence'), '70%');
  assert.equal(value(j, 'Probability up'), '62%');
  assert.ok(j.some(l => l.text === 'Price was already moving'));
  assert.equal(value(j, 'After 5 min'), '+12.3 bp');
  assert.equal(value(j, 'After 15 min'), '-4.0 bp');
  assert.equal(value(j, 'After 30 min'), 'Too recent');
  assert.equal(value(j, 'Worst within 15 min'), '-6.5 bp');
  assert.match(j[j.length - 1]!.text, /no edge yet/);
  const c = signalLines(call(MIN));
  assert.equal(c[0]!.text, 'Short: confluence call');
  assert.equal(value(c, 'Families agreeing / against'), '3 / 1');
  assert.equal(value(c, 'Triggers'), 'oi, cvd');
  assert.equal(value(c, 'After 5 min'), 'Too recent');
  assert.ok(!c.some(l => l.label === 'Jev score'));
});

test('summaryOf: count, known, mean and share of the 15-minute results', () => {
  assert.deepEqual(summaryOf([]), { count: 0, known: 0, meanR15: null, positive: null });
  const s = summaryOf([jev(MIN, 3, false, { ...none, r15: 10 }), jev(2 * MIN, 3, false, { ...none, r15: -4 }), call(3 * MIN)]);
  assert.deepEqual(s, { count: 3, known: 2, meanR15: 3, positive: 0.5 });
});

test('getSignals asks for the window and drops malformed signals', async () => {
  const requests: string[] = [];
  const good = jev(MIN, 3, null, { r5: 1, r15: null, r30: null, best15: null, worst15: null });
  const rows: unknown[] = [good, call(2 * MIN),
    { ...good, kind: 'other' }, { ...good, t: 'x' }, { ...good, side: 'up' }, { ...good, after: { ...none, r5: 'x' } }, { ...good, after: { r5: null } },
    { ...good, jev: { score: 3, confidence: 0.6, p: 0.5, underway: 'no' } }, { ...call(3 * MIN), confluence: { score: 0, agree: 1, against: 0, triggers: [1] } }, null];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return { ok: true, status: 200, json: async () => ({ coin: 'BTC', signals: rows }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const answer = await getSignals(1.5, 9.2);
    assert.deepEqual(requests, ['/api/v2/signals?from=1&to=10']);
    assert.equal(answer.coin, 'BTC');
    assert.deepEqual(answer.signals, [good, call(2 * MIN)]);
  } finally { globalThis.fetch = original; }
});
