import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confluence } from '../src/shared/volatility/confluence.ts';
import { VolatilityWatch, subqArmsFrom } from '../src/server/v2/volatility.mts';
import type { VolatilityInputs } from '../src/shared/volatility/features.ts';
import { SUBQ_ARMS, type DecisionExtras, type SubqArm } from '../src/shared/volatility/jev.ts';

/** Spot buying hard, asks pulled while bids held: two families say up. */
const upFlowAndBook = { spotZ15: 2.4, whaleOpposite: false, bidChangePct: 2, askChangePct: -40, ltFlipped: false, ltNow: 0.01, imbPctile6h: 50, imb1pct: 0.02 };

test('a call needs two families agreeing, none against, and something unusual this minute', () => {
  const quiet = confluence({ ...upFlowAndBook, volSigma: 0.3, liqZ5: 0, liqLong5: 0, liqShort5: 0 });
  assert.equal(quiet.direction, 'up');
  assert.equal(quiet.agree, 2);
  assert.equal(quiet.call, false, 'agreement on an ordinary minute is a drift, not a call');

  const active = confluence({ ...upFlowAndBook, volSigma: 2.5, liqZ5: 0, liqLong5: 0, liqShort5: 0 });
  assert.deepEqual([active.direction, active.agree, active.against, active.call, active.triggers], ['up', 2, 0, true, ['highlight']]);

  // A short squeeze's liquidations vote down (forced buyers at a pivot) and are themselves the trigger: one family against kills the call.
  const contested = confluence({ ...upFlowAndBook, volSigma: 0.3, liqZ5: 3, liqLong5: 0, liqShort5: 5_000_000 });
  assert.equal(contested.votes.positioning, -0.5);
  assert.deepEqual([contested.direction, contested.against, contested.call], ['up', 1, false]);
});

test('readings within one family never count as two agreeing families', () => {
  const c = confluence({ spotZ15: 3, whaleOpposite: true, whaleNet60: 5_000_000, binanceSpotZ60: 2, slicerShare: 0.8, volSigma: 4 });
  assert.equal(c.votes.flow, 1, 'clamped to one full vote');
  assert.equal(c.votes.book, null);
  assert.deepEqual([c.agree, c.call], [1, false]);
});

test('bids pulled while asks hold vote down; both sides pulled is no vote; the tracker flipping casts no vote', () => {
  assert.equal(confluence({ bidChangePct: -45, askChangePct: 0 }).votes.book, -0.5);
  assert.equal(confluence({ bidChangePct: -45, askChangePct: -45 }).votes.book, 0);
  assert.equal(confluence({}).direction, null);
  assert.equal(confluence({ ltFlipped: true, ltNow: 0.2, lt30: -0.1 }).votes.book, null);
  assert.equal(confluence({ bidChangePct: 2, askChangePct: -40, ltFlipped: true, ltNow: -0.2 }).votes.book, 0.5, 'a flip to the asks does not cancel asks pulled');
});

test('without a key the watch still reads and logs the confluence every minute, and never asks Jev', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volatility-confluence-'));
  const now = Date.UTC(2026, 9, 13, 12, 0);
  const px = new Float32Array(10).fill(100_000), flow = new Float32Array(10).fill(1_000);
  const inputs: VolatilityInputs = {
    now, coin: 'BTC', spot: [], perp: [{ id: 'p', t0: now - 10 * 60_000, buy: flow, sell: flow, px, lo: px, hi: px }],
    binanceSpotId: null, refPerpId: 'p', depth: [], liquidations: [], oi: [], whale: [],
  };
  let asked = 0;
  const watch = new VolatilityWatch({ dir, read: () => inputs, clock: () => now + 15_000, ask: async () => { asked++; throw new Error('not asked'); } });
  await watch.tick();
  const answer = watch.answer();
  assert.equal(asked, 0);
  assert.equal(answer.enabled, false);
  assert.equal(answer.coin, 'BTC');
  assert.equal(answer.confluence?.length, 1);
  assert.equal(answer.confluence![0]!.t, now);
  const rows = fs.readFileSync(path.join(dir, 'volatility-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.confluence && !('verdict' in rows[0]!));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a SubQ arm left out of SUBQ_ARMS is never asked, its history is never built, and it is absent from the log', async () => {
  assert.deepEqual(subqArmsFrom(undefined), { arms: [...SUBQ_ARMS], unknown: [] });
  assert.deepEqual(subqArmsFrom(''), { arms: [], unknown: [] }, 'set but empty: every arm paused');
  assert.deepEqual(subqArmsFrom('subq, subqimage ,subqImage'), { arms: ['subq', 'subqImage'], unknown: ['subqimage'] });

  const now = Date.UTC(2026, 9, 13, 12, 0);
  const px = new Float32Array(10).fill(100_000), flow = new Float32Array(10).fill(1_000);
  const inputs: VolatilityInputs = {
    now, coin: 'BTC', spot: [], perp: [{ id: 'p', t0: now - 10 * 60_000, buy: flow, sell: flow, px, lo: px, hi: px }],
    binanceSpotId: null, refPerpId: 'p', depth: [], liquidations: [], oi: [], whale: [],
  };
  const run = async (subqArms?: SubqArm[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volatility-arms-'));
    const asked: DecisionExtras[] = [];
    const watch = new VolatilityWatch({ dir, read: () => inputs, clock: () => now + 15_000, subqKey: 'key', ...(subqArms ? { subqArms } : {}), ask: async (features, _key, _signal, extras = {}) => {
      asked.push(extras);
      return { t: features.t, coin: features.coin, price: features.price, concepts: {}, score: 1, scoreConfidence: 0.5, direction: 'up', directionP: 0.6, model: 'subq-snap-preview' };
    } });
    await watch.tick();
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'volatility-log.jsonl'), 'utf8')) as { arms?: Record<string, unknown> };
    fs.rmSync(dir, { recursive: true, force: true });
    return { asked, logged: Object.keys(row.arms ?? {}).sort(), answered: Object.keys(watch.answer().arms ?? {}) };
  };
  const every = await run();
  assert.deepEqual(every.logged, ['subq', 'subqHistory'], 'by default the history arm is asked (no heatmap here, so the image arm is not)');
  assert.ok(every.asked.some(x => typeof x.series === 'string'));
  const paused = await run(['subq', 'subqImage']);
  assert.deepEqual(paused.asked, [{ provider: 'subq' }]);
  assert.deepEqual(paused.logged, ['subq']);
  assert.ok(!paused.answered.includes('subqHistory'));
});
