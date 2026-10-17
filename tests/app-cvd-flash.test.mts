import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowSeries } from '../src/shared/flow.ts';
import { END_GAP_MS, flowEndChange, type FlowEnd } from '../src/app/cvd/flash.ts';

/** `n` seconds, each buying `buy` and selling `sell` (USD). */
function seconds(n: number, buy: number, sell: number): { buy: number[]; sell: number[] } {
  return { buy: Array.from({ length: n }, () => buy), sell: Array.from({ length: n }, () => sell) };
}

test('a line end measures only the flow at its live edge since it was last drawn', () => {
  const s = new FlowSeries(), t0 = 1_700_000_000;
  const { buy, sell } = seconds(100, 3_000, 1_000);
  s.load(t0, buy, sell);
  let at = 10_000;
  const first = flowEndChange(s, undefined, at);
  assert.equal(first.change, 0, 'nothing on the first drawing');
  let end: FlowEnd = first.end!;
  assert.deepEqual(end, { sec: t0 + 99, own: 2_000, at });
  // The open second grows (the recorder sends its running total), and a new second comes.
  s.set(t0 + 99, 9_000, 1_000); s.set(t0 + 100, 50_000, 0);
  at += 1_000;
  const next = flowEndChange(s, end, at);
  assert.equal(next.change, 6_000 + 50_000, 'what the open second added and the new second');
  end = next.end!;
  assert.equal(flowEndChange(s, end, at + 1_000).change, 0, 'nothing new, nothing to flash');
});

test('older history loaded under a line is not a change at its end, whatever its net', () => {
  const s = new FlowSeries(), t0 = 1_700_000_000;
  const live = seconds(60, 2_000, 1_000);
  s.load(t0, live.buy, live.sell);
  const end = flowEndChange(s, undefined, 0).end!;
  // The column asks for history further back (hub.ensureFlow): the series is rebuilt from an hour earlier, its running delta restarting
  // there, so every total moves by that hour's net, $3.6M here, and the old reading of the running delta would have flashed it.
  const older = seconds(3_600, 1_500, 500);
  s.load(t0 - 3_600, [...older.buy, ...live.buy], [...older.sell, ...live.sell]);
  assert.equal(s.cumDelta(Number.MAX_SAFE_INTEGER), end.own * 60 + 3_600_000, 'the running total did move by the hour loaded');
  assert.equal(flowEndChange(s, end, 1_000).change, 0, 'the end did not');
  // Live seconds held while the history came are put on top: those are new and count.
  s.set(t0 + 60, 30_000, 0);
  assert.equal(flowEndChange(s, end, 1_000).change, 30_000);
});

test('after a pause, or with the second it saw gone, a line end starts afresh', () => {
  const s = new FlowSeries(), t0 = 1_700_000_000;
  s.set(t0, 1_000, 0);
  const end = flowEndChange(s, undefined, 0).end!;
  s.set(t0 + 30, 400_000, 0);
  assert.equal(flowEndChange(s, end, END_GAP_MS + 1).change, 0, 'the column was hidden: what came meanwhile is not new now');
  assert.equal(flowEndChange(s, end, END_GAP_MS).change, 400_000);
  s.clear(); s.set(t0 + 40, 5_000, 0);
  assert.equal(flowEndChange(s, end, 1_000).change, 0, 'a series started again after the second seen');
  const cleared = new FlowSeries();
  assert.deepEqual(flowEndChange(cleared, end, 1_000), { end: null, change: 0 }, 'an empty series keeps nothing');
});
