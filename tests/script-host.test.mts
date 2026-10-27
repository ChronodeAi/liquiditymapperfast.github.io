import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptHost, type WorkerLike } from '../src/app/script/host.ts';
import type { RunRequest, RunResponse, ScriptJob } from '../src/app/script/protocol.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: RunResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: RunRequest[] = [];
  ended = false;
  postMessage(m: RunRequest): void { this.posted.push(m); }
  terminate(): void { this.ended = true; }
  ready(): void { this.onmessage?.({ data: { t: 'ready' } }); }
  answer(seq: number, ids: string[]): void { this.onmessage?.({ data: { t: 'result', seq, results: ids.map(id => ({ id, ok: true, plots: [], warnings: [], steps: 1, ms: 1 })) } }); }
}

const inputs = (): BarInputs => { const a = new Float64Array(1); return { tf: 60_000, time: a, open: new Float64Array(1), high: new Float64Array(1), low: new Float64Array(1), close: new Float64Array(1), volume: new Float64Array(1), sources: {}, forming: false }; };
const job = (id: string): ScriptJob => ({ id, source: 'line(1)', options: {}, api: 1 });

function rig(autoReady = true) {
  const workers: FakeWorker[] = [], timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const host = new ScriptHost({
    spawn: () => { const w = new FakeWorker(); workers.push(w); queueMicrotask(() => { if (autoReady) w.ready(); }); return w; },
    deadlineMs: 1_000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { (t as { cleared: boolean }).cleared = true; },
  });
  return { host, workers, timers };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

test('a run is answered with one result per script, in the order asked', async () => {
  const { host, workers } = rig();
  const p = host.run([job('a'), job('b')], inputs());
  assert.equal(workers.length, 1);
  await tick();
  const sent = workers[0]!.posted[0]!;
  workers[0]!.answer(sent.seq, ['b', 'a']);
  const r = await p;
  assert.deepEqual(r.map(x => x.id), ['a', 'b']);
  assert.equal(host.busy, false);
});

test('while a run is under way the newest request waits and an older waiting one is dropped', async () => {
  const { host, workers } = rig();
  const first = host.run([job('a')], inputs());
  const second = host.run([job('b')], inputs());
  const third = host.run([job('c')], inputs());
  await tick();
  assert.deepEqual(await second, [], 'overtaken before it started');
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await first)[0]!.id, 'a');
  assert.equal(workers[0]!.posted.length, 2);
  workers[0]!.answer(workers[0]!.posted[1]!.seq, ['c']);
  assert.equal((await third)[0]!.id, 'c');
});

test('a run past its deadline ends its worker, reports every script stopped, and the next run gets a fresh worker', async () => {
  const { host, workers, timers } = rig();
  const p = host.run([job('a'), job('b')], inputs());
  await tick();
  const deadline = timers.find(t => t.ms === 1_000 && !t.cleared)!;
  deadline.fn();
  const r = await p;
  assert.ok(r.every(x => !x.ok && x.error.code === 'timeout'));
  assert.equal(workers[0]!.ended, true);
  assert.equal(host.restarts, 1);
  // A late answer from the ended worker changes nothing.
  workers[0]!.answer(1, ['a']);
  const q = host.run([job('a')], inputs());
  assert.equal(workers.length, 2);
  await tick();
  workers[1]!.answer(workers[1]!.posted[0]!.seq, ['a']);
  assert.equal((await q)[0]!.ok, true);
  assert.ok(timers.filter(t => t.ms === 1_000).every(t => t.cleared || t === deadline), 'an answered run clears its deadline');
});

test('a worker that fails stops its run, and an answer to an older run is ignored', async () => {
  const { host, workers } = rig();
  const p = host.run([job('a')], inputs());
  await tick();
  workers[0]!.answer(999, ['a']);
  assert.equal(host.busy, true);
  workers[0]!.onerror?.(new Error('load'));
  const r = await p;
  assert.equal(!r[0]!.ok && r[0]!.error.code, 'worker-failed');
});

test('the clock of a run starts only once its worker has loaded, and a worker that never loads is given up on', async () => {
  const { host, workers, timers } = rig(false);
  const p = host.run([job('a')], inputs());
  assert.equal(workers[0]!.posted.length, 0, 'nothing is sent before the worker says it has loaded');
  assert.ok(!timers.some(t => t.ms === 1_000), 'no run deadline yet: loading is not running');
  workers[0]!.ready();
  assert.equal(workers[0]!.posted.length, 1);
  assert.ok(timers.some(t => t.ms === 1_000 && !t.cleared));
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await p)[0]!.ok, true);
  const second = rig(false);
  const q = second.host.run([job('b')], inputs());
  second.timers.find(t => t.ms !== 1_000)!.fn();
  const r = await q;
  assert.equal(!r[0]!.ok && r[0]!.error.code, 'worker-failed');
  assert.equal(second.workers[0]!.ended, true);
});
