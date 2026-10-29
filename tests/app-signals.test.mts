import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_DEFAULTS, SignalBook, aheadLines, aheadSummaryOf, readSignals, signalLines, summaryOf, type SignalSettings } from '../src/app/signals.ts';
import type { AheadWarning } from '../src/shared/volatility/ahead.ts';
import { getSignals } from '../src/app/net.ts';
import { WARN_MIN_SCORE } from '../src/shared/volatility/jev.ts';
import { SIGNAL_MIN_SCORE, type Signal, type SignalAfter } from '../src/shared/volatility/signals.ts';

const MIN = 60_000;
const none: SignalAfter = { r5: null, r15: null, r30: null, best15: null, worst15: null };
const jev = (t: number, score: number, underway: boolean | null, after: SignalAfter = none): Signal =>
  ({ kind: 'jev', t, price: 100, side: 'long', jev: { score, confidence: 0.7, p: 0.62, underway }, after });
const call = (t: number, after: SignalAfter = none): Signal =>
  ({ kind: 'confluence', t, price: 100, side: 'short', confluence: { score: -0.4, agree: 3, against: 1, triggers: ['oi', 'cvd'] }, after });
const all: SignalSettings = { on: true, ahead: true, jev: true, confluence: true, minScore: SIGNAL_MIN_SCORE, duringMoves: true };
const warning = (tf: AheadWarning['tf'], t: number, after: Partial<AheadWarning['after']> = {}): AheadWarning =>
  ({ tf, t, price: 80_000, z: 2.6, times: 3.4, sigma: 0.002, after: { moved: null, at: null, up: null, down: null, done: false, ...after } });

test('readSignals: defaults, bounds, halves, junk', () => {
  assert.deepEqual(readSignals(undefined), SIGNAL_DEFAULTS);
  assert.deepEqual(SIGNAL_DEFAULTS, { on: false, ahead: true, jev: false, confluence: false, minScore: WARN_MIN_SCORE, duringMoves: false }, 'the warnings on, the sided signals off');
  assert.deepEqual(readSignals('junk'), SIGNAL_DEFAULTS);
  assert.equal(readSignals({ minScore: 0 }).minScore, SIGNAL_MIN_SCORE);
  assert.equal(readSignals({ minScore: 9 }).minScore, 4);
  assert.equal(readSignals({ minScore: 2.7 }).minScore, 2.5);
  assert.equal(readSignals({ minScore: 3.3 }).minScore, 3.5);
  assert.equal(readSignals({ minScore: Number.NaN }).minScore, WARN_MIN_SCORE);
  assert.equal(readSignals({ minScore: '3' }).minScore, WARN_MIN_SCORE);
  assert.deepEqual(readSignals({ on: true, ahead: false, jev: true, confluence: 1, duringMoves: true }), { on: true, ahead: false, jev: true, confluence: false, minScore: WARN_MIN_SCORE, duringMoves: true });
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
  // Ten minutes apart, so each is an episode of its own.
  book.add([jev(10 * MIN, 2, false), jev(20 * MIN, 3, true), jev(30 * MIN, 3, null), jev(40 * MIN, 3, false), call(50 * MIN), jev(90 * MIN, 4, false)]);
  const at = (s: SignalSettings): string[] => book.visible(0, 80 * MIN, s).map(x => `${x.kind}:${x.t / MIN}`);
  assert.deepEqual(at(all), ['jev:10', 'jev:20', 'jev:30', 'jev:40', 'confluence:50'], 'the window is [from, to)');
  assert.deepEqual(at({ ...all, minScore: 2.5 }), ['jev:20', 'jev:30', 'jev:40', 'confluence:50']);
  assert.deepEqual(at({ ...all, duringMoves: false }), ['jev:10', 'jev:40', 'confluence:50'], 'under way or unknown is hidden');
  assert.deepEqual(at({ ...all, jev: false }), ['confluence:50']);
  assert.deepEqual(at({ ...all, confluence: false, minScore: 4 }), []);
});

test('visible: calls of one kind and side at most five minutes apart are one episode, marked at its first call', () => {
  const book = new SignalBook();
  const short = (t: number): Signal => ({ ...jev(t, 3, false), side: 'short' });
  book.add([jev(0, 3, false), jev(2 * MIN, 3, false), jev(7 * MIN, 3, false), short(3 * MIN), call(MIN), call(4 * MIN), jev(13 * MIN, 3, false)]);
  const shown = book.visible(0, 60 * MIN, all);
  assert.deepEqual(shown.map(x => `${x.kind}:${x.side}:${x.t / MIN}:${x.episode.count}:${x.episode.last / MIN}`),
    ['jev:long:0:3:7', 'confluence:short:1:2:4', 'jev:short:3:1:3', 'jev:long:13:1:13'], 'a gap of 6 minutes starts a new episode; sides and kinds are apart');
  // The settings filter before grouping: a call they hide does not join or split an episode.
  assert.deepEqual(book.visible(0, 60 * MIN, { ...all, minScore: 4 }).map(x => x.kind), ['confluence']);
  // An episode that began before the window is not drawn again inside it; one going on past the window's end keeps counting.
  assert.deepEqual(book.visible(MIN, 60 * MIN, all).map(x => `${x.kind}:${x.t / MIN}`), ['confluence:1', 'jev:3', 'jev:13'], 'the long Jev episode began at 0');
  assert.equal(book.visible(0, MIN, all)[0]!.episode.count, 3);
  // Replay passes its moment: nothing after it is counted.
  assert.deepEqual(book.visible(0, 60 * MIN, all, 3 * MIN).map(x => `${x.t / MIN}:${x.episode.count}`), ['0:2', '1:1']);
  const lines = signalLines(shown[0]!);
  assert.equal(lines.find(l => l.label === 'Calls in this episode')?.text, '3 · 7 min');
  assert.ok(!signalLines(shown[2]!).some(l => l.label === 'Calls in this episode'), 'a single call says nothing about episodes');
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
  const fine = warning(15, 20 * MIN, { moved: 'up', at: 25 * MIN, up: 41.2, down: -3, done: true });
  const warnings: unknown[] = [fine, { ...fine, tf: 30 }, { ...fine, sigma: 0 }, { ...fine, after: { ...fine.after, moved: 'sideways' } }, { ...fine, after: { ...fine.after, up: 'x' } }, { ...fine, after: { ...fine.after, done: 1 } }];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return { ok: true, status: 200, json: async () => requests.length > 1 ? { coin: 'BTC', signals: [] } : ({ coin: 'BTC', signals: rows, ahead: warnings }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const answer = await getSignals(1.5, 9.2);
    assert.deepEqual(requests, ['/api/v2/signals?from=1&to=10']);
    assert.equal(answer.coin, 'BTC');
    assert.deepEqual(answer.signals, [good, call(2 * MIN)]);
    assert.deepEqual(answer.ahead, [fine], 'a warning that is not what AheadWarning says is dropped');
    assert.deepEqual((await getSignals(1, 2)).ahead, [], 'an older server answers none');
  } finally { globalThis.fetch = original; }
});

test('the book keeps the volatility-ahead warnings by timeframe and bar, and draws them by the switch and the replay moment', () => {
  const book = new SignalBook();
  book.addAhead([warning(5, 10 * MIN), warning(60, 10 * MIN), warning(15, 30 * MIN)]);
  assert.deepEqual(book.ahead.map(w => `${w.tf}:${w.t / MIN}`), ['5:10', '60:10', '15:30']);
  const v = book.version;
  book.addAhead([warning(5, 10 * MIN)]);
  assert.equal(book.version, v, 'the same again changes nothing');
  book.addAhead([warning(5, 10 * MIN, { up: 12, down: -4 })]);
  assert.equal(book.ahead.length, 3);
  assert.equal(book.ahead[0]!.after.up, 12, 'what came after fills in');
  assert.deepEqual(book.aheadVisible(0, 20 * MIN, all).map(w => w.tf), [5, 60], 'the window is [from, to)');
  assert.deepEqual(book.aheadVisible(0, 60 * MIN, all, 30 * MIN).map(w => w.t / MIN), [10, 10], 'replay: none from its moment on');
  assert.deepEqual(book.aheadVisible(0, 60 * MIN, { ...all, ahead: false }), []);
  book.clear();
  assert.deepEqual(book.ahead, []);
});

test('aheadLines: where a break and a full move would be, and what came after', () => {
  const value = (lines: ReturnType<typeof aheadLines>, label: string): string | undefined => lines.find(l => l.label === label)?.text;
  const open = aheadLines(warning(5, 10 * MIN));
  assert.equal(open[0]!.text, 'Volatility ahead (5m)');
  assert.equal(value(open, 'Volume'), '3.4× its usual (z 2.6)');
  assert.equal(value(open, 'σ, the usual 3-bar move'), '0.20 % · $160');
  assert.equal(value(open, 'Breakout at (±1σ)'), '80,160.0 / 79,840.0');
  assert.equal(value(open, 'Big move reaches (±2σ)'), '80,320.0 / 79,680.0');
  assert.ok(open.some(l => l.text === 'Still watching'));
  assert.ok(!open.some(l => l.label === 'Furthest up / down'), 'nothing known after it yet');
  const quiet = aheadLines(warning(60, 10 * MIN, { up: 8, down: -11.5, done: true }));
  assert.equal(quiet[0]!.text, 'Volatility ahead (1h)');
  assert.ok(quiet.some(l => l.text === 'No 2σ move within its 6 bars'));
  assert.equal(value(quiet, 'Furthest up / down'), '+8.0 bp ($64) / -11.5 bp ($92)', 'basis points of the price, and those dollars');
  const moved = aheadLines(warning(15, 10 * MIN, { moved: 'down', at: 40 * MIN, up: 2, down: -40, done: true }));
  assert.ok(moved.some(l => /^Moved down 2σ by /.test(l.text) && l.color === 'sell'));
  assert.match(moved.at(-1)!.text, /does not say which way/);
});

test('aheadSummaryOf: of the warnings whose bars are over, how many saw a 2σ move', () => {
  assert.deepEqual(aheadSummaryOf([]), { count: 0, done: 0, moved: 0 });
  assert.deepEqual(aheadSummaryOf([warning(5, 0, { done: true, moved: 'up', at: MIN }), warning(5, MIN, { done: true }), warning(15, 2 * MIN)]), { count: 3, done: 2, moved: 1 });
});
