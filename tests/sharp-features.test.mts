import test from 'node:test';
import assert from 'node:assert/strict';
import { sharpFeatures, type SharpInputs } from '../src/shared/sharp/features.ts';
import type { FlowMinutesSeries } from '../src/shared/flow.ts';

const MINUTE = 60_000, M = 1e6;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

/** `minutes` minutes ending at NOW: buy and sell come from `at(i, fromEnd)` (fromEnd 0 = the last minute). */
function series(id: string, minutes: number, at: (fromEnd: number) => [buy: number, sell: number]): FlowMinutesSeries {
  const buy = new Float32Array(minutes), sell = new Float32Array(minutes), px = new Float32Array(minutes).fill(100_000), zeros = new Float32Array(minutes);
  for (let i = 0; i < minutes; i++) { const [b, s] = at(minutes - 1 - i); buy[i] = b; sell[i] = s; }
  return { id, t0: NOW - minutes * MINUTE, buy, sell, px, lo: zeros, hi: zeros };
}
/** Deterministic noise in [-1, 1]. */
const noise = (i: number): number => Math.sin(i * 12.9898) * Math.cos(i * 4.1414);
const inputs = (over: Partial<SharpInputs>): SharpInputs => ({ now: NOW, coin: 'BTC', spot: [], perp: [], binanceSpotId: null, refPerpId: 'perp', depth: [], liquidations: [], oi: [], whale: [], ...over });

test('spot buying while perpetuals sell, after a quiet day, reads as opposite sides many sigma out', () => {
  const quietThenSplit = (sign: 1 | -1) => (fromEnd: number): [number, number] => {
    if (fromEnd < 15) return sign > 0 ? [7.5 * M, 2.5 * M] : [2.5 * M, 7.5 * M];
    const n = 0.25 * M * noise(fromEnd);
    return [10 * M + n, 10 * M - n];
  };
  const f = sharpFeatures(inputs({ spot: [series('spot', 25 * 60, quietThenSplit(1))], perp: [series('perp', 25 * 60, quietThenSplit(-1))] }))!;
  assert.ok(f);
  assert.equal(f.values.spotPerpOpposite, true);
  assert.ok((f.values.spotZ15 as number) > 2, `spotZ15 ${f.values.spotZ15}`);
  assert.ok((f.values.perpZ15 as number) < -2, `perpZ15 ${f.values.perpZ15}`);
  assert.match(f.words.spotPerpDivergence!, /Spot taker flow over the last 15 minutes is \+\d/);
});

test('with too little history there is no baseline, so no z-score and no sentence built on one', () => {
  const noisy = (fromEnd: number): [number, number] => { const n = 0.25 * M * noise(fromEnd); return [10 * M + n, 10 * M - n]; };
  const f = sharpFeatures(inputs({ spot: [series('spot', 2 * 60, noisy)], perp: [series('perp', 2 * 60, noisy)] }))!;
  assert.equal(f.values.spotZ15, null);
  assert.equal(f.values.perpZ60, null);
  assert.equal(f.values.spotPerpOpposite, null);
  assert.equal(f.words.spotPerpDivergence, undefined);
});

test('no price, or nothing recorded, gives no features', () => {
  assert.equal(sharpFeatures(inputs({})), null);
  const flat = (): [number, number] => [1, 1];
  const noPrice = series('perp', 60, flat); noPrice.px.fill(0);
  assert.equal(sharpFeatures(inputs({ perp: [noPrice] })), null);
});

test('bids within 1 % dropping by 60 % in the last minute read as -60 %, the asks untouched', () => {
  const depth = Array.from({ length: 360 }, (_, i) => ({ t: NOW - (360 - i) * MINUTE, bidUsd: 100 * M, askUsd: 100 * M, ltBid: 1, ltAsk: 1 }));
  depth[359]!.bidUsd = 40 * M;
  const f = sharpFeatures(inputs({ perp: [series('perp', 120, () => [1 * M, 1 * M])], depth }))!;
  assert.ok(Math.abs((f.values.bidChangePct as number) + 60) < 0.01, `bidChangePct ${f.values.bidChangePct}`);
  assert.ok(Math.abs(f.values.askChangePct as number) < 0.01);
  assert.match(f.words.liquidityPulled!, /-60 % on the bid side and \+0 % on the ask side/);
});

test('the tracker flipping from bids to asks over half an hour is flagged', () => {
  const depth = Array.from({ length: 60 }, (_, i) => ({ t: NOW - (60 - i) * MINUTE, bidUsd: 1, askUsd: 1, ltBid: i < 30 ? 3 : 1, ltAsk: i < 30 ? 1 : 3 }));
  const f = sharpFeatures(inputs({ perp: [series('perp', 120, () => [1 * M, 1 * M])], depth }))!;
  assert.equal(f.values.ltFlipped, true);
  assert.ok((f.values.ltNow as number) < 0 && (f.values.lt30 as number) > 0);
});

test('liquidations and whale net flow are summed by side and window', () => {
  const flow = series('perp', 120, () => [2 * M, 1 * M]);
  const liquidations = [
    { t: NOW - 2 * MINUTE, side: 'long' as const, usd: 3 * M }, { t: NOW - 10 * MINUTE, side: 'long' as const, usd: 1 * M },
    { t: NOW - 1 * MINUTE, side: 'short' as const, usd: 0.5 * M }, { t: NOW - 30 * MINUTE, side: 'short' as const, usd: 9 * M },
  ];
  const whale = [{ t: NOW - 5 * MINUTE, buyUsd: 0, sellUsd: 4 * M }, { t: NOW - 90 * MINUTE, buyUsd: 50 * M, sellUsd: 0 }];
  const f = sharpFeatures(inputs({ perp: [flow], liquidations, whale }))!;
  assert.equal(f.values.liqLong5, 3 * M);
  assert.equal(f.values.liqShort5, 0.5 * M);
  assert.equal(f.values.liqLong15, 4 * M);
  assert.equal(f.values.liqShort15, 0.5 * M);
  assert.equal(f.values.whaleNet60, -4 * M);
  assert.equal(f.values.whaleOpposite, true, 'whales sold while everyone else bought');
});
