import test from 'node:test';
import assert from 'node:assert/strict';
import { askDecision, SHARP_QUESTIONS } from '../src/shared/sharp/jev.ts';
import type { SharpFeatures } from '../src/shared/sharp/features.ts';

const features: SharpFeatures = {
  coin: 'BTC', t: Date.UTC(2026, 9, 12, 12), price: 100_000, values: { spotZ15: 2.1 },
  words: { spotPerpDivergence: 'Spot is buying, perps are selling.', liquidationCascade: 'No liquidations.' },
};
const body = (over: Record<string, unknown> = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    spotPerpDivergence: { type: 'noul', noul: 0.8 }, liquidationCascade: { type: 'noul', noul: 0.1 },
    sharpMove: { type: 'score', score: 3.2, confidence: 0.7, legend: {} },
    direction: { type: 'choice', choice: 'down', probabilities: { up: 0.3, down: 0.7 }, confidence: 0.4 },
    ...over,
  },
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function withFetch<T>(respond: (init: RequestInit) => Response, run: () => Promise<T>): Promise<{ result: T; sent: { url: string; init: RequestInit }[] }> {
  const real = globalThis.fetch, sent: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: String(url), init: init ?? {} }); return respond(init ?? {}); }) as typeof fetch;
  try { return { result: await run(), sent }; } finally { globalThis.fetch = real; }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('a valid answer becomes a verdict, and only concepts with a reading are asked', async () => {
  const { result, sent } = await withFetch(() => json(body()), () => askDecision(features, 'key'));
  const { ms, ...rest } = result;
  assert.ok(typeof ms === 'number' && ms >= 0);
  assert.deepEqual(rest, { t: features.t, coin: 'BTC', price: 100_000, concepts: { spotPerpDivergence: 0.8, liquidationCascade: 0.1 }, score: 3.2, scoreConfidence: 0.7, direction: 'down', directionP: 0.7, model: 'jev-1.13.0', inputTokens: 1 });
  assert.equal(sent[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, 'Bearer key');
  const request = JSON.parse(String(sent[0]!.init.body)) as { model: string; questions: Record<string, unknown>; state: { readings: unknown } };
  assert.equal(request.model, 'jev-latest');
  assert.deepEqual(Object.keys(request.questions).sort(), ['direction', 'liquidationCascade', 'sharpMove', 'spotPerpDivergence']);
  assert.deepEqual(request.questions.sharpMove, SHARP_QUESTIONS.sharpMove);
  assert.deepEqual(request.state.readings, features.words);
});

test('an answer out of range or of the wrong type is refused', async () => {
  for (const bad of [
    { spotPerpDivergence: { type: 'noul', noul: 1.4 } },
    { spotPerpDivergence: { type: 'choice', noul: 0.5 } },
    { sharpMove: { type: 'score', score: 5, confidence: 0.5 } },
    { sharpMove: { type: 'score', score: 2, confidence: null } },
    { direction: { type: 'choice', probabilities: { up: 0.5 } } },
    { liquidationCascade: undefined },
  ]) {
    await assert.rejects(withFetch(() => json(body(bad)), () => askDecision(features, 'key')), /decision: malformed answer/);
  }
  await assert.rejects(withFetch(() => json('nope'), () => askDecision(features, 'key')), /decision: malformed answer/);
});

test('an HTTP error names its status', async () => {
  await assert.rejects(withFetch(() => json({ error: 'no' }, 401), () => askDecision(features, 'key')), /jev: HTTP 401/);
});

test('SubQ gets the same questions at its own endpoint, with the history in the state and the images beside it', async () => {
  const images = [{ mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' }];
  const { sent } = await withFetch(() => json(body()), () => askDecision(features, 'key', undefined, { provider: 'subq', series: 'utc,price\n12:00,100000', images }));
  assert.equal(sent[0]!.url, 'https://api.subq.ai/v1/systemone');
  const request = JSON.parse(String(sent[0]!.init.body)) as { model: string; images: unknown; state: { history_csv: string }; questions: Record<string, unknown> };
  assert.equal(request.model, 'subq-snap-preview');
  assert.deepEqual(request.images, images);
  assert.equal(request.state.history_csv, 'utc,price\n12:00,100000');
  assert.deepEqual(Object.keys(request.questions).sort(), ['direction', 'liquidationCascade', 'sharpMove', 'spotPerpDivergence']);
  await assert.rejects(withFetch(() => json({ detail: {} }, 429), () => askDecision(features, 'key', undefined, { provider: 'subq' })), /subq: HTTP 429/);
});
