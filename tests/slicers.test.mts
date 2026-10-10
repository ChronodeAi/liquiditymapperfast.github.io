import test from 'node:test';
import assert from 'node:assert/strict';
import { GRACE_MS, SLICER_DEFAULTS, SlicerDetector, families, type SlicerEpisode, type SlicerOptions } from '../src/shared/slicers.ts';

const MIN = 60_000, T0 = 1_800_000_000_000, ID = 'binancespot:ETHUSDT';
type Side = 'buy' | 'sell';
interface Order { instrumentId: string; side: Side; t: number; usd: number }

/** A seeded generator (mulberry32), so every stream here is the same on every run. */
function rng(seed: number): () => number {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Unrelated market orders: random times (`perMin` a minute), either side, sizes spread evenly in log from $100 to $50K. */
function noise(rand: () => number, from: number, to: number, perMin: number, id = ID): Order[] {
  const out: Order[] = [];
  for (let t = from; ; ) {
    t += -Math.log(1 - rand()) * MIN / perMin;
    if (t >= to) return out;
    out.push({ instrumentId: id, side: rand() < 0.5 ? 'buy' : 'sell', t: Math.round(t), usd: Math.exp(Math.log(100) + rand() * Math.log(500)) });
  }
}
/** Orders of a program: one every `every` ms from `from` to `to`, of the size `size` gives. */
function program(from: number, to: number, every: number, side: Side | (() => Side), size: () => number, id = ID): Order[] {
  const out: Order[] = [];
  for (let t = from; t < to; t += every) out.push({ instrumentId: id, side: typeof side === 'function' ? side() : side, t: t + 137, usd: size() });
  return out;
}
/** Feed the orders in time order with the clock at each one, then run the clock to `until`; the last snapshot of every episode. */
function run(orders: Order[], until: number, options: Partial<SlicerOptions> = {}, scale = 1): SlicerEpisode[] {
  const d = new SlicerDetector(options, scale), seen = new Map<string, SlicerEpisode>();
  const take = () => { for (const e of d.takeFresh()) seen.set(e.id, e); };
  for (const o of [...orders].sort((a, b) => a.t - b.t)) { d.step(o.t); d.add([o]); take(); }
  d.step(until); take();
  return [...seen.values()].sort((a, b) => a.onset - b.onset);
}

test('a fixed clip every three seconds is an exact episode: onset, alert fifteen minutes on, end once it stops', () => {
  const rand = rng(1), start = T0 + 15 * MIN, stop = T0 + 75 * MIN;
  const clips = program(start, stop, 3_000, 'buy', () => 5_000 + rand() * 2 - 1), orders = [...noise(rand, T0, T0 + 120 * MIN, 120), ...clips];
  const episodes = run(orders, T0 + 120 * MIN);
  assert.equal(episodes.length, 1, 'one program, one episode');
  const e = episodes[0]!;
  assert.equal(e.side, 'buy'); assert.equal(e.exact, true, 'its sizes are within 0.2 % of each other'); assert.equal(e.repeat, false);
  assert.ok(e.onset >= start && e.onset <= start + 5 * MIN, `onset ${(e.onset - T0) / MIN} min, soon after the program began`);
  assert.equal(e.alertAt - e.onset, (SLICER_DEFAULTS.sustain - 1) * MIN, 'the alert comes with the fifteenth candidate minute');
  assert.ok(e.end !== null && e.end >= stop && e.end <= stop + 3 * MIN, `ended ${e.end === null ? 'never' : (e.end - T0) / MIN} min, once its clips stopped`);
  assert.equal(e.gap, 3, 'its cadence'); assert.ok(Math.abs(e.clip - 5_000) < 2);
  // Every minute from the onset to the last was a candidate, so the total is the program's clips in them, and the few unrelated buys within
  // 0.2 % of $5K (as like its clips as can be; about one in ten minutes here).
  const own = clips.filter(c => c.t >= e.onset && c.t < e.last + MIN).reduce((s, c) => s + c.usd, 0);
  assert.ok(e.total >= own - 1 && e.total <= own + 10 * 5_000, `total $${e.total.toFixed(0)}, clips $${own.toFixed(0)}`);
});

test('a program drawing each clip at random from $1-6K about once a second is found by the wide kind alone', () => {
  const rand = rng(2), start = T0 + 20 * MIN;
  const orders = [...noise(rand, T0, T0 + 90 * MIN, 30), ...program(start, T0 + 80 * MIN, 1_000, 'buy', () => Math.exp(Math.log(1_000) + rand() * Math.log(6))).filter(() => rand() < 0.8)];
  const episodes = run(orders, T0 + 90 * MIN);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.exact, false, 'no fixed size');
  assert.equal(episodes[0]!.gap, 1);
  assert.equal(run(orders, T0 + 90 * MIN, { kinds: SLICER_DEFAULTS.kinds.filter(k => k.name === 'exact') }).length, 0, 'the fixed-size test alone does not see it');
});

test('busy unrelated orders, a one-minute burst and a two-sided program are no episode', () => {
  const rand = rng(3);
  assert.deepEqual(run(noise(rand, T0, T0 + 180 * MIN, 600), T0 + 180 * MIN), [], 'ten orders a second of every size, either side');
  const burst = program(T0 + 30 * MIN, T0 + 31 * MIN, 1_000, 'sell', () => 4_000);
  assert.deepEqual(run([...noise(rand, T0, T0 + 60 * MIN, 60), ...burst], T0 + 60 * MIN), [], 'a minute is not fifteen');
  const twoSided = program(T0 + 15 * MIN, T0 + 75 * MIN, 3_000, () => (rand() < 0.5 ? 'buy' : 'sell'), () => 5_000);
  assert.deepEqual(run([...noise(rand, T0, T0 + 90 * MIN, 60), ...twoSided], T0 + 90 * MIN), [], 'half its clips each way: no side to report');
});

test('the same side and clip again within six hours is shown as a repeat; the other side or another clip is not', () => {
  const rand = rng(4), clip = () => 5_000 + rand() - 0.5;
  const orders = [
    ...noise(rand, T0, T0 + 260 * MIN, 60),
    ...program(T0 + 15 * MIN, T0 + 50 * MIN, 3_000, 'buy', clip),
    ...program(T0 + 80 * MIN, T0 + 115 * MIN, 3_000, 'buy', clip),
    ...program(T0 + 140 * MIN, T0 + 175 * MIN, 3_000, 'sell', clip),
    ...program(T0 + 200 * MIN, T0 + 235 * MIN, 2_000, 'buy', () => 20_000 + rand() * 4 - 2),
  ];
  const episodes = run(orders, T0 + 260 * MIN);
  assert.deepEqual(episodes.map(e => [e.side, Math.round(e.clip / 1_000), e.repeat]), [['buy', 5, false], ['buy', 5, true], ['sell', 5, false], ['buy', 20, false]]);
});

test('a running episode does not go on with a family that is no longer one-sided', () => {
  const rand = rng(6), stop = T0 + 50 * MIN;
  // A $5K buyer, then both sides trading $5K clips at the same pace: the family still has a cadence, but no side.
  const orders = [...program(T0 + 5 * MIN, stop, 3_000, 'buy', () => 5_000), ...program(stop, T0 + 120 * MIN, 1_500, () => (rand() < 0.5 ? 'buy' : 'sell'), () => 5_000)];
  const [e] = run(orders, T0 + 120 * MIN);
  assert.ok(e && e.end !== null && e.end <= stop + 10 * MIN, `ended ${e?.end === null ? 'never' : ((e?.end ?? 0) - T0) / MIN} min`);
});

test('a feed that stops still closes its episode, and an order older than the window counts nowhere', () => {
  const rand = rng(5), d = new SlicerDetector();
  const orders = program(T0, T0 + 60 * MIN, 3_000, 'buy', () => 5_000 + rand() - 0.5);
  for (const o of orders) { d.step(o.t); d.add([o]); }
  assert.equal(d.active().length, 1, 'running while its clips come');
  d.add([{ instrumentId: ID, side: 'sell', t: T0, usd: 5_000 }]);
  assert.equal(d.read(ID, T0 + 59 * MIN).filter(r => r.side === 'sell').length, 0, 'a clip from before the window is not in it');
  d.takeFresh();
  d.step(T0 + 90 * MIN);
  // Its last clips are still in the windows of the next minutes (updates), then it ends.
  const ended = d.takeFresh().filter(e => e.end !== null);
  assert.equal(ended.length, 1); assert.ok(ended[0]!.end! <= T0 + 62 * MIN, `ended ${(ended[0]!.end! - T0) / MIN} min`);
  assert.equal(d.active().length, 0);
});

test('the floors follow the coin: $500 clips are a program at a tenth of BTC\'s sizes and nothing at BTC\'s', () => {
  const orders = program(T0 + 5 * MIN, T0 + 60 * MIN, 3_000, 'sell', () => 500);
  assert.equal(run(orders, T0 + 60 * MIN, {}, 0.1).length, 1);
  assert.equal(run(orders, T0 + 60 * MIN, {}, 1).length, 0, 'under the $1K clip floor');
});

test('a minute is judged only once the clock is past its end and the grace', () => {
  const d = new SlicerDetector(), first = { instrumentId: ID, side: 'buy' as const, t: T0, usd: 2_000 };
  d.add([first]);
  // Watched from T0's next whole minute: the first judged minute is the tenth after it.
  const firstJudged = Math.floor(T0 / MIN) * MIN + MIN + 9 * MIN;
  for (const o of program(T0, firstJudged + MIN, 1_000, 'buy', () => 3_000)) d.add([o]);
  d.step(firstJudged + MIN + GRACE_MS - 1); d.takeFresh();
  assert.equal(d.read(ID, firstJudged).length > 0, true, 'its window is held until it is judged');
});

test('size families: the fullest bucket takes its free neighbours, the rest make their own', () => {
  const c = (usd: number) => ({ s: 0, side: 'buy' as const, usd });
  const groups = families([c(5_000), c(5_001), c(5_002), c(5_011), c(5_030), c(9_000)], 0.002);
  assert.deepEqual(groups.map(g => g.map(x => x.usd).sort((a, b) => a - b)), [[5_000, 5_001, 5_002, 5_011], [5_030], [9_000]]);
});
