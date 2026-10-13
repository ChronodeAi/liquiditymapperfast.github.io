import test from 'node:test';
import assert from 'node:assert/strict';
import { FOOTPRINT_REFRESH_MS, FootprintData } from '../src/app/panes/footprint.ts';
import type { FootprintResponse } from '../src/app/source.ts';

const H = 3_600_000;
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A source holding one bar an hour that answers at most `per` bars a question, newest first, and says where it started; every question logged. */
function source(per: number) {
  const asked: { from: number; to: number; budget: number }[] = [], answered: number[] = [];
  const load = async (_inst: string, _tf: string, from: number, to: number, _rows: number, _cuts: readonly number[], budget: number): Promise<FootprintResponse> => {
    asked.push({ from, to, budget });
    const bars = [];
    for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < per; t -= H) bars.unshift({ t, rows: [[100, t / H, 1]] as [number, number, number][], buyUsd: t / H, sellUsd: 1, minutes: 60 });
    answered.push(...bars.map(bar => bar.t));
    return { step: 5, fine: 5, bars, from: bars.length ? bars[0]!.t : from };
  };
  return { asked, answered, load };
}

/** performance.now as the test says, for the refresh interval. */
function clock(start: number) {
  let now = start; const real = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  return { advance: (ms: number) => { now += ms; }, restore: () => Object.defineProperty(performance, 'now', { value: real, configurable: true, writable: true }) };
}

test('a long view comes in slices, newest first, each bar asked for once; then only the bars that can still change, every refresh', async () => {
  const time = clock(1_000_000);
  try {
    const { asked, answered, load } = source(5), data = new FootprintData(), view = { t0: 10 * H, t1: 20 * H, p0: 0, p1: 1 };
    const sourceNow = 20 * H + 30 * 60_000;
    const step = async () => { data.ensure('a,b', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    assert.deepEqual(asked[0], { from: 9 * H, to: 21 * H, budget: 5_000 }, 'the whole view with its margin, within the budget');
    assert.deepEqual([...data.bars.keys()], [16, 17, 18, 19, 20].map(h => h * H), 'the newest part first');
    await step(); await step(); await step();
    assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H]), [[9, 16], [9, 11]], 'then older slices until the view is covered, and nothing more');
    assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(new Set(answered).size, answered.length, 'no bar is merged twice: each slice starts where the last one reached');

    time.advance(FOOTPRINT_REFRESH_MS);
    await step();
    assert.deepEqual([asked.at(-1)!.from / H, asked.at(-1)!.to / H], [20, 21], 'the refresh asks for the open bar alone: the ones before it are settled');
    assert.equal(data.bars.size, 12);
    await step();
    assert.equal(asked.length, 4, 'and not again before the next refresh');

    // A view wholly in the past asks nothing on the clock once it is held.
    const past = { t0: 2 * H, t1: 6 * H, p0: 0, p1: 1 }, before = asked.length;
    for (let i = 0; i < 3; i++) { data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn(); }
    time.advance(FOOTPRINT_REFRESH_MS * 3);
    data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn();
    assert.deepEqual(asked.slice(before).map(a => [a.from / H, a.to / H]), [[1, 7], [1, 2]], 'its bars in two slices, then nothing');
  } finally { time.restore(); }
});

test('another row size asks again from the view, and an old source that answers the whole window is taken whole', async () => {
  const asked: number[][] = [];
  const whole = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
    asked.push([from / H, to / H]);
    const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
    return { step: 5, fine: 5, bars };
  };
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked, [[9, 13]], 'no `from` in the answer: the whole window was answered');
  data.ensure('a', '1h', view, 10, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked.at(-1), [9, 13]);
  assert.equal(asked.length, 2);
});

test('a view with more bars than are held for long is not asked for again on every look, and panning right through the past asks from the held end', async () => {
  const time = clock(5_000_000);
  try {
    const M = 60_000, asked: number[][] = [];
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push([from, to]);
      const bars = []; for (let t = from; t < to; t += M) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 1 });
      return { step: 5, fine: 5, bars };
    };
    const data = new FootprintData(), wide = { t0: 0, t1: 4_000 * M, p0: 0, p1: 1 };
    for (let i = 0; i < 4; i++) { data.ensure('a', '1m', wide, 5, load, () => {}, [], 10 * 86_400_000); await turn(); }
    assert.equal(asked.length, 1, 'more than 3 000 bars in view, all past: one question, then none');
    assert.equal(data.bars.size, 4_002);

    // Hourly bars held for [9h, 13h) with the source at 30h; the view moves to [12h, 15h).
    const hourly: number[][] = [];
    const loadH = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      hourly.push([from / H, to / H]);
      const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
      return { step: 5, fine: 5, bars };
    };
    const past = new FootprintData();
    past.ensure('a', '1h', { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    past.ensure('a', '1h', { t0: 12 * H, t1: 14 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    assert.deepEqual(hourly, [[9, 13], [13, 15]], 'the bars after the held ones, not from the settled time far beyond them');
    assert.deepEqual([...past.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14]);

    past.clear();
    assert.equal(past.bars.size, 0, 'no markets to count: no bars');
  } finally { time.restore(); }
});
