import test from 'node:test';
import assert from 'node:assert/strict';
import { withTail, toStore, type ColumnStore } from '../src/app/worker/column-store.ts';
import { Hub, settledBefore } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';
import type { BootstrapState, DataSource } from '../src/app/source.ts';
import type { ColumnSet, ColumnsFrame } from '../src/app/wire.ts';
import { DepthRecorder, COLUMN_MS, SAMPLE_MS } from '../src/shared/recorder.ts';
import { packColumns } from '../src/shared/engine.ts';
import type { ValuedBook, SideLevels } from '../src/shared/levels.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';

/**
 * The page's 30 s refresh of the recorded columns asks only for the windows that could have changed since they were asked for: every window
 * that ended two minutes or more before the last answer stays as it was. Its answer replaces the columns held from where it starts.
 */

const MIN = COLUMN_MS, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 12, 6, 0);

/** Element by element, NaN equal to NaN (the trackers mark a column without one with NaN). */
function sameStore(actual: ColumnStore, expected: ColumnStore, label: string): void {
  assert.equal(actual.step, expected.step, `${label}: step`);
  for (const key of ['times', 'counts', 'bins', 'bid', 'ask', 'lt'] as const) {
    const a = actual[key], b = expected[key];
    assert.equal(a === undefined, b === undefined, `${label}: ${key} present on both or neither`);
    if (!a || !b) continue;
    assert.equal(a.length, b.length, `${label}: ${key} length`);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(`${label}: ${key}[${i}] ${a[i]} against ${b[i]}`);
  }
}

const set = (id: string, columns: { t: number; bins: number[]; lt?: boolean }[], withLt: boolean): ColumnSet => {
  const bins = columns.flatMap(c => c.bins);
  return { id, step: 10, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(() => 12),
    bins: Int32Array.from(bins), bid: Float32Array.from(bins, b => b * 2), ask: Float32Array.from(bins, b => b * 3),
    ...(withLt ? { lt: Float32Array.from({ length: columns.length * LT_LENGTH }, (_, i) => columns[Math.floor(i / LT_LENGTH)]!.lt === false ? NaN : i + 1) } : {}) };
};

test('a tail replaces the columns held from its start and keeps those before, trackers side by side', () => {
  const held = toStore(set('a', [{ t: 0, bins: [1, 2] }, { t: 60, bins: [3] }, { t: 120, bins: [4, 5, 6] }], true));
  const tail = set('a', [{ t: 120, bins: [7] }, { t: 180, bins: [8, 9] }], false);
  const merged = withTail(held, tail, 120);
  assert.deepEqual([...merged.times], [0, 60, 120, 180]);
  assert.deepEqual([...merged.counts], [2, 1, 1, 2]);
  assert.deepEqual([...merged.bins], [1, 2, 3, 7, 8, 9]);
  assert.deepEqual([...merged.bid], [2, 4, 6, 14, 16, 18]);
  assert.deepEqual([...merged.ask], [3, 6, 9, 21, 24, 27]);
  // The kept columns' trackers, then NaN for the tail's, which has none.
  assert.deepEqual([...merged.lt!].slice(0, 2 * LT_LENGTH), [...held.lt!].slice(0, 2 * LT_LENGTH));
  assert.ok([...merged.lt!].slice(2 * LT_LENGTH).every(Number.isNaN));
  // The other way round: none held, the tail's own.
  const plain = withTail(toStore(set('a', [{ t: 0, bins: [1] }], false)), set('a', [{ t: 60, bins: [2] }], true), 60);
  assert.ok([...plain.lt!].slice(0, LT_LENGTH).every(Number.isNaN));
  assert.deepEqual([...plain.lt!].slice(LT_LENGTH), [...set('a', [{ t: 60, bins: [2] }], true).lt!]);
  // Neither has a tracker: none; nothing held: the tail alone; a tail from before all that is held: the tail alone.
  assert.equal(withTail(toStore(set('a', [{ t: 0, bins: [1] }], false)), set('a', [{ t: 60, bins: [2] }], false), 60).lt, undefined);
  sameStore(withTail(undefined, tail, 120), toStore(tail), 'nothing held');
  sameStore(withTail(held, tail, -60), toStore(tail), 'from before everything held');
});

const levels = (rows: [number, number][]): SideLevels => ({ lo: Float64Array.from(rows, r => r[0]), hi: Float64Array.from(rows, r => r[0]), usd: Float64Array.from(rows, r => r[1]) });

test('a full answer and then a tail from where it settled equal a full answer asked afterwards, at every step', () => {
  let seed = 3;
  const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
  let now = T0;
  const recorder = new DepthRecorder({ now: () => now });
  const ids = ['a:BTC', 'b:BTC'];
  for (const id of ids) recorder.steps.set(id, 10);
  const sampleUntil = (end: number): void => {
    for (; now < end; now += SAMPLE_MS) {
      const books: ValuedBook[] = ids.map(id => ({ instrumentId: id, venue: id.split(':')[0]!, timestamp: now, coarse: false,
        bids: levels(Array.from({ length: 6 }, (_, i) => [84_000 - i * 10 - Math.round(rnd() * 3) * 10, 1e5 + rnd() * 1e6])),
        asks: levels(Array.from({ length: 6 }, (_, i) => [84_010 + i * 10 + Math.round(rnd() * 3) * 10, 1e5 + rnd() * 1e6])) }));
      // b skips a stretch: a window with no minutes, then minutes again.
      recorder.sample(books.filter(b => b.instrumentId === 'a:BTC' || now < T0 + 70 * MIN || now > T0 + 95 * MIN), now);
    }
  };
  const ask = (from: number, to: number, stepMs: number): ColumnsFrame => ({ from, to, stepMs, instruments: packColumns(ids.map(id => ({ instrumentId: id, step: 10, columns: recorder.query(id, from, to, stepMs) }))) });
  // T1 inside a window of every step (08:07:17): the window two minutes before it has not ended at T1, so a tail that started after it
  // would keep that window as it was.
  const T1 = T0 + 2 * HOUR + 7 * MIN + 17_000, T2 = T1 + 30 * MIN + 41_000;
  sampleUntil(T1);
  const first = new Map<number, ColumnsFrame>(), steps = [MIN, 4 * MIN, 16 * MIN];
  for (const step of steps) first.set(step, ask(T1 - 2 * HOUR, T1 + MIN, step));
  sampleUntil(T2);
  for (const step of steps) {
    const from = settledBefore(T1, step), tail = ask(from, T2 + MIN, step), fresh = ask(T1 - 2 * HOUR, T2 + MIN, step);
    first.get(step)!.instruments.forEach((held, i) => {
      sameStore(withTail(toStore(held), tail.instruments[i]!, from), toStore(fresh.instruments[i]!), `${held.id} at ${step / MIN} min`);
    });
  }
});

class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; posted: { type: string; from?: number }[] = []; postMessage(message: { type: string; from?: number }): void { this.posted.push(message); } }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class ColumnSource {
  readonly kind = 'server' as const;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  asked: { from: number; to: number; stepMs: number }[] = [];
  hold: Promise<void> | null = null;
  /** The price grid every market is answered on. */
  grid = 10;
  /** The source's clock at bootstrap (0: it does not say). */
  clock = 0;
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: this.clock, dataMode: 'server', markPrice: 100, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(): { close(): void } { return { close() {} }; }
  async candles() { return []; }
  async oi() { return []; }
  async prints() { return []; }
  async flow() { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> {
    this.asked.push({ from, to, stepMs });
    if (this.hold) await this.hold;
    return { from, to, stepMs, instruments: ids.map(id => ({ id, step: this.grid, times: [], counts: [], samples: [], bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) })) };
  }
}

test('the hub asks for the whole window once, then on each refresh only from where the last answer settled, and nothing for a view in the past', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const store = new Store(initialState()), source = new ColumnSource();
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    store.set({ levels: { asOf: now, books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } as never });
    const posted = () => worker.posted.filter(m => m.type === 'columns' || m.type === 'columnsTail').map(m => [m.type, m.from]);
    // Six hours on 180 px: columns of four minutes.
    const live = () => ({ t0: now - 6 * HOUR, t1: now + 10 * MIN, p0: 0, p1: 1 }), step = 4 * MIN;
    await hub.loadColumns(live(), 180);
    assert.deepEqual(source.asked, [{ from: Math.floor((T0 - 9 * HOUR - 5 * MIN) / step) * step, to: T0 + MIN, stepMs: step }], 'the window and half of it each side, in whole windows, up to now');
    await hub.loadColumns(live(), 180);
    assert.equal(source.asked.length, 1, 'nothing new without a refresh');
    for (let k = 1; k <= 2; k++) {
      now = T0 + k * 30_000; hub.invalidateColumns();
      await hub.loadColumns(live(), 180);
      assert.deepEqual(source.asked.at(-1), { from: settledBefore(T0 + (k - 1) * 30_000, step), to: now + MIN, stepMs: step }, `refresh ${k}: from where the answer before settled`);
    }
    assert.deepEqual(posted().map(p => p[0]), ['columns', 'columnsTail', 'columnsTail']);
    assert.equal(posted().at(-1)![1], settledBefore(T0 + 30_000, step));
    // A view wholly in the past: one answer, and no refresh asks again.
    const past = { t0: T0 - 3 * DAY, t1: T0 - 2 * DAY, p0: 0, p1: 1 }, count = source.asked.length;
    await hub.loadColumns(past, 180);
    assert.equal(source.asked.length, count + 1);
    now += 30_000; hub.invalidateColumns(); await hub.loadColumns(past, 180);
    assert.equal(source.asked.length, count + 1, 'a recorded minute does not change');
    // A refresh asked for while an answer is on its way is answered by the next load.
    let release!: () => void;
    source.hold = new Promise(resolve => { release = resolve; });
    const loading = hub.loadColumns(live(), 180);
    hub.invalidateColumns();
    release(); await loading; source.hold = null;
    const before = source.asked.length;
    await hub.loadColumns(live(), 180);
    assert.equal(source.asked.length, before + 1, 'the refresh marked meanwhile asks again');
    assert.equal(worker.posted.at(-1)!.type, 'columnsTail');
    // A market answered on another price grid than its columns held (the server started again): the whole window is asked for again.
    source.grid = 20;
    now += 30_000; hub.invalidateColumns();
    const asked = source.asked.length;
    await hub.loadColumns(live(), 180);
    assert.equal(source.asked.length, asked + 2, 'the tail, and then the whole window');
    assert.equal(source.asked.at(-1)!.from, Math.floor((live().t0 - 3 * HOUR - 5 * MIN) / step) * step);
    assert.equal(worker.posted.at(-1)!.type, 'columns');
    now += 30_000; hub.invalidateColumns(); await hub.loadColumns(live(), 180);
    assert.equal(worker.posted.at(-1)!.type, 'columnsTail', 'and refreshes go on from there on the new grid');
  } finally { Date.now = realNow; }
});

test('windows settle by the source clock, and the whole window is asked for again every hour', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    // The page's clock runs four minutes ahead of the server's.
    const store = new Store(initialState()), source = new ColumnSource();
    source.clock = T0 - 4 * MIN;
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    store.set({ levels: { asOf: now, books: [{ id: 'a:BTC' }] } as never });
    const live = () => ({ t0: now - 6 * HOUR, t1: now + 10 * MIN, p0: 0, p1: 1 }), step = 4 * MIN;
    await hub.loadColumns(live(), 180);
    assert.equal(source.asked[0]!.to, T0 - 4 * MIN + MIN, 'up to the source now');
    now += 30_000; hub.invalidateColumns(); await hub.loadColumns(live(), 180);
    assert.equal(source.asked.at(-1)!.from, settledBefore(T0 - 4 * MIN, step), 'settled by the source clock, not the page clock');
    // Refreshes go on as tails for an hour from the whole window, then it is asked for whole again.
    for (; now < T0 + HOUR - 30_000;) { now += 30_000; hub.invalidateColumns(); await hub.loadColumns(live(), 180); }
    assert.equal(worker.posted.at(-1)!.type, 'columnsTail');
    now += 30_000; hub.invalidateColumns(); await hub.loadColumns(live(), 180);
    assert.equal(worker.posted.at(-1)!.type, 'columns', 'an hour on, the whole window');
  } finally { Date.now = realNow; }
});

test('a tail on another price grid replaces the columns held rather than joining them', () => {
  const held = toStore(set('a', [{ t: 0, bins: [1, 2] }, { t: 60, bins: [3] }], false));
  const other = { ...set('a', [{ t: 60, bins: [7] }], false), step: 20 };
  sameStore(withTail(held, other, 60), toStore(other), 'another grid');
});
