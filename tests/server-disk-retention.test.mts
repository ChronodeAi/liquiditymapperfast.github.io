import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DELETE_BATCH, DISK_RETENTION_MS, deleteMinutesBefore, diskRetentionMs, keepBefore } from '../src/server/v2/keep.mts';
import { SqliteColumnStore } from '../src/server/v2/store.mts';
import { SqliteFootprintStore } from '../src/server/v2/footprint.mts';
import { SqliteFlowStore } from '../src/server/v2/flow.mts';
import { SqliteCoverageStore, TradeCoverage } from '../src/server/v2/coverage.mts';
import { SqliteLiquidationStore, LiquidationStream } from '../src/server/v2/liquidations.mts';
import { SqlitePrintStore, PrintStream, PRINT_FLOOR_USD } from '../src/server/v2/prints.mts';
import { SqliteAbsorptionStore, AbsorptionRecorder } from '../src/server/v2/absorption.mts';
import { DepthRecorder, HOT_MS, RETENTION_MS } from '../src/server/v2/recorder.mts';
import { FootprintRecorder as FootprintCore } from '../src/shared/footprint.ts';
import { FlowRecorder as FlowCore, FLOW_STORE_MS } from '../src/shared/flow.ts';
import { ABSORPTION_RETENTION_MS, type AbsorptionStep } from '../src/shared/absorption.ts';
import { LIQUIDATION_RETENTION_MS } from '../src/shared/liquidations.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';

const DAY = 86_400_000, MIN = 60_000;
const NOW = 1_800_000_000_000;
/** The week every recorder keeps in memory and reads at its start, and what the disk keeps. */
const WEEK = 7 * DAY;
/** A row's age in days when it was written, and the ones a 30-day disk keeps or lets go of. */
const AGES = [31, 29, 20, 8, 3, 1];
const KEPT = [29, 20, 8, 3, 1];
const at = (age: number): number => NOW - age * DAY;

const tmp = (): { dir: string; file: string; done: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmf-disk-')), file = path.join(dir, 'h.sqlite');
  return { dir, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
/** The ages (days, oldest first) of the rows a table holds in its time column. */
const agesIn = (file: string, table: string, column = 't'): number[] => {
  const db = new DatabaseSync(file);
  try { return (db.prepare(`SELECT ${column} AS t FROM ${table} ORDER BY ${column} DESC`).all() as { t: number }[]).map(row => (NOW - row.t) / DAY); } finally { db.close(); }
};
/** `inner` with every method call recorded (name and arguments) and passed on. */
const spy = <T extends object>(inner: T, calls: [string, unknown[]][]): T => new Proxy(inner, {
  get: (target, key) => {
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? (...args: unknown[]): unknown => { calls.push([String(key), args]); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
  },
});
const sinces = (calls: [string, unknown[]][], ...names: string[]): number[] => calls.filter(([name]) => names.includes(name)).map(([, args]) => Number(args[0]));

test('the disk retention is 30 days, LMF_DISK_RETENTION_DAYS sets it from 7 to 365 days, and anything else is 30', () => {
  assert.equal(diskRetentionMs(undefined), 30 * DAY);
  assert.equal(diskRetentionMs(''), 30 * DAY);
  for (const days of ['7', '30', '90', '365']) assert.equal(diskRetentionMs(days), Number(days) * DAY, days);
  assert.equal(diskRetentionMs(' 14 '), 14 * DAY);
  for (const bad of ['6', '0', '-30', '366', '1000', '12.5', '1e2', 'abc', '30d', 'NaN', 'Infinity', '99999999999999999999']) assert.equal(diskRetentionMs(bad), 30 * DAY, bad);
  assert.equal(DISK_RETENTION_MS, diskRetentionMs(process.env.LMF_DISK_RETENTION_DAYS), 'the constant is the environment read once');
});

test('keepBefore is the older of the recorder cutoff and what the disk keeps', () => {
  assert.equal(keepBefore(NOW - WEEK, NOW), NOW - DISK_RETENTION_MS, 'a week-old cutoff gives way to the disk retention');
  assert.equal(keepBefore(NOW - DISK_RETENTION_MS - 5 * DAY, NOW), NOW - DISK_RETENTION_MS - 5 * DAY, 'a cutoff older than the disk retention stands');
  assert.equal(keepBefore(0, NOW), 0);
  assert.equal(keepBefore(NOW - WEEK, NOW + 10 * DAY), NOW + 10 * DAY - DISK_RETENTION_MS, 'the clock is the one given');
  assert.ok(Math.abs(keepBefore(Date.now() - WEEK) - (Date.now() - DISK_RETENTION_MS)) < 5_000, 'the real clock by default');
  assert.ok(DISK_RETENTION_MS >= WEEK, 'the disk never keeps less than the recorders');
});

test('the recorders keep a week in memory, as the disk retention assumes', () => {
  assert.equal(RETENTION_MS, WEEK); assert.equal(FLOW_STORE_MS, WEEK); assert.equal(ABSORPTION_RETENTION_MS, WEEK); assert.equal(LIQUIDATION_RETENTION_MS, WEEK);
});

test('the minute tables are cleared a batch at a time, instrument by instrument, through the (inst, t) key', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE flow_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t))');
    const insert = db.prepare('INSERT INTO flow_minutes (inst, t, data) VALUES (?, ?, ?)');
    for (const inst of ['a:BTC', 'b:BTC', 'c:ETH']) for (let i = 0; i < 25; i++) insert.run(inst, i * MIN, new Uint8Array(1));
    assert.equal(deleteMinutesBefore(db, 'flow_minutes', 10 * MIN, 4), 30, 'ten minutes of each of three, four rows to a statement');
    const left = db.prepare('SELECT inst, COUNT(*) AS n, MIN(t) AS first FROM flow_minutes GROUP BY inst ORDER BY inst').all() as { inst: string; n: number; first: number }[];
    assert.deepEqual(left.map(r => [r.inst, r.n, r.first / MIN]), [['a:BTC', 15, 10], ['b:BTC', 15, 10], ['c:ETH', 15, 10]]);
    assert.equal(deleteMinutesBefore(db, 'flow_minutes', 10 * MIN, 4), 0, 'nothing more to delete');
    assert.equal(deleteMinutesBefore(db, 'flow_minutes', 1e15), 45, 'everything, the default batch');
    assert.equal(DELETE_BATCH, 5_000);
    db.exec('CREATE TABLE footprint_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, step REAL, rows TEXT, PRIMARY KEY (inst, t))');
    const plan = (db.prepare('EXPLAIN QUERY PLAN DELETE FROM footprint_minutes WHERE rowid IN (SELECT rowid FROM footprint_minutes WHERE inst = ? AND t < ? LIMIT ?)').all('a', 0, 1) as { detail: string }[]).map(r => r.detail).join(' | ');
    assert.match(plan, /SEARCH .*USING (COVERING )?INDEX/, 'a seek on the key, not a scan of the table');
    assert.doesNotMatch(plan, /SCAN footprint_minutes/);
  } finally { db.close(); }
});

test('prints and liquidations: rows of 8, 20 and 29 days are kept on disk, 31 days is deleted; the stream reads only its week', () => {
  const { file, done } = tmp();
  try {
    const prints = new SqlitePrintStore(file, () => NOW);
    prints.save(AGES.map(age => ({ t: at(age), id: 'x:BTC', side: 'buy' as const, price: 100 + age, usd: 100_000 })), NOW - WEEK);
    prints.close();
    assert.deepEqual(agesIn(file, 'prints'), KEPT.slice().sort((a, b) => a - b));
    const stream = new PrintStream(file, () => NOW);
    assert.deepEqual(stream.query(at(40), NOW, PRINT_FLOOR_USD).map(p => (NOW - p.t) / DAY), [3, 1], 'asked back past the week it still answers the week');
    const seen: number[] = []; stream.eachIn(at(40), NOW, p => seen.push((NOW - p.t) / DAY));
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 3]);
    stream.close();

    const liquidations = new SqliteLiquidationStore(file, () => NOW);
    liquidations.save(AGES.map(age => ({ t: at(age), id: 'x:BTC', side: 'long' as const, price: 100 + age, usd: 500_000, reported: 100 + age, kind: 'fill' as const })), NOW - WEEK);
    liquidations.close();
    assert.deepEqual(agesIn(file, 'liquidations'), KEPT.slice().sort((a, b) => a - b));
    const forced = new LiquidationStream(file, () => NOW);
    assert.deepEqual(forced.query(at(40), NOW, 0).map(l => (NOW - l.t) / DAY), [3, 1]);
    forced.close();
  } finally { done(); }
});

test('footprint and flow minutes: 8, 20 and 29 days are kept, 31 days deleted; the start loads the week', () => {
  const { file, done } = tmp();
  try {
    const footprint = new SqliteFootprintStore(file, () => NOW);
    footprint.save(['x:BTC', 'y:BTC'].flatMap(inst => AGES.map(age => ({ inst, t: at(age), step: 10, bins: [[85_000, 1_000, 2_000] as [number, number, number]], stats: null }))), NOW - WEEK);
    footprint.close();
    assert.deepEqual(agesIn(file, 'footprint_minutes'), [...KEPT, ...KEPT].sort((a, b) => a - b));

    const flow = new SqliteFlowStore(file, () => NOW);
    flow.save(['x:BTC', 'y:BTC'].flatMap(inst => AGES.map(age => ({ inst, t: at(age), buy: new Float32Array(60).fill(1), sell: new Float32Array(60).fill(2) }))), NOW - WEEK);
    flow.close();
    assert.deepEqual(agesIn(file, 'flow_minutes'), [...KEPT, ...KEPT].sort((a, b) => a - b));

    const footCalls: [string, unknown[]][] = [], reopenedFootprint = new SqliteFootprintStore(file, () => NOW);
    const recorder = new FootprintCore(spy(reopenedFootprint, footCalls), () => NOW);
    assert.ok(sinces(footCalls, 'load').length > 0 && sinces(footCalls, 'load').every(since => since >= NOW - WEEK), 'the footprint start asks for the week');
    assert.deepEqual([1, 3, 8, 20].map(age => recorder.holds('x:BTC', at(age))), [true, true, false, false], 'and holds the week');
    recorder.close();

    const flowCalls: [string, unknown[]][] = [], reopenedFlow = new SqliteFlowStore(file, () => NOW);
    const flows = new FlowCore(spy(reopenedFlow, flowCalls), () => NOW);
    assert.deepEqual(sinces(flowCalls, 'load'), [NOW - WEEK], 'the flow start asks for the week');
    assert.ok((flows.coverage()['x:BTC']?.first ?? 0) >= NOW - WEEK);
    flows.close();
  } finally { done(); }
});

test('absorption groups and minutes: 8, 20 and 29 days are kept, 31 days deleted; questions and the packing read only the week', async () => {
  const { file, done } = tmp();
  try {
    const step = (t: number): AbsorptionStep => [50_000, 1, 1, t, t];
    const store = new SqliteAbsorptionStore(file, () => NOW);
    store.save(
      ['x:BTC', 'y:BTC'].flatMap(id => AGES.map(age => ({ id, side: 'buy' as const, price: 100, t0: at(age), steps: [step(at(age))] }))),
      ['x:BTC', 'y:BTC'].flatMap(id => AGES.map(age => ({ id, t: at(age), n: 3, mean: 1, m2: 0, floor: 25_000 }))),
      NOW - WEEK);
    // An instrument that was only recorded before the week is on the disk and not asked about.
    store.save([{ id: 'old:BTC', side: 'sell', price: 100, t0: at(20), steps: [step(at(20))] }], [], NOW - WEEK);
    assert.deepEqual(store.instruments(), ['old:BTC', 'x:BTC', 'y:BTC'], 'a store lists what it holds');
    assert.deepEqual(store.instruments(NOW - WEEK), ['x:BTC', 'y:BTC'], 'and from a date on');
    store.close();
    assert.deepEqual(agesIn(file, 'absorption_groups', 't0'), [...KEPT, ...KEPT, 20].sort((a, b) => a - b));
    assert.deepEqual(agesIn(file, 'absorption_minutes'), [...KEPT, ...KEPT].sort((a, b) => a - b));

    const recorder = new AbsorptionRecorder(file, () => NOW);
    try {
      const answer = await recorder.query(['x:BTC'], [0], at(40), NOW, 100, at(40));
      assert.deepEqual(answer.groups.map(g => (NOW - g.t0) / DAY).sort((a, b) => a - b), [1, 3], 'groups of the week');
      assert.deepEqual(answer.minutes.map(m => (NOW - m.t) / DAY).sort((a, b) => a - b), [1, 3], 'minutes of the week');
    } finally { recorder.close(); }
  } finally { done(); }
});

test('coverage rows follow the disk retention; the record reports the week', () => {
  const { file, done } = tmp();
  try {
    const store = new SqliteCoverageStore(file, () => NOW);
    store.save(AGES.map(age => ({ inst: 'x:BTC', metric: 'trades' as const, from: at(age), to: at(age) + 10 * MIN, kind: 'live' as const })), NOW - WEEK);
    store.close();
    assert.deepEqual(agesIn(file, 'coverage', 't0'), KEPT.slice().sort((a, b) => a - b));
    const coverage = new TradeCoverage(file, () => NOW);
    assert.deepEqual(coverage.spans('x:BTC').map(s => (NOW - s.from) / DAY).sort((a, b) => a - b), [1, 3], 'the server\'s week, as before');
    coverage.close();
  } finally { done(); }
});

test('depth columns and trackers: 8, 20 and 29 days are kept on disk; the recorder starts and reports the week', () => {
  const { file, done } = tmp();
  try {
    const store = new SqliteColumnStore(file, () => NOW);
    for (const age of AGES) store.save('x:BTC', { t: at(age), n: 1, bins: Int32Array.of(4), bid: Float32Array.of(1), ask: Float32Array.of(0), lt: new Float32Array(LT_LENGTH).fill(1), ltN: 1 }, 20);
    store.prune(NOW - RETENTION_MS);
    store.close();
    assert.deepEqual(agesIn(file, 'depth_columns'), KEPT.slice().sort((a, b) => a - b));
    assert.deepEqual(agesIn(file, 'depth_lt'), KEPT.slice().sort((a, b) => a - b));

    const again = new SqliteColumnStore(file, () => NOW);
    const recorder = new DepthRecorder({ store: again, now: () => NOW, memoryMs: HOT_MS });
    assert.equal(recorder.coverage()['x:BTC']?.first, at(3), 'the first recorded minute is the week\'s, not the disk\'s');
    recorder.prune(NOW);
    assert.deepEqual(agesIn(file, 'depth_columns'), KEPT.slice().sort((a, b) => a - b), 'a recorder\'s prune leaves the disk\'s days');
    recorder.flush(); again.close();
  } finally { done(); }
});
