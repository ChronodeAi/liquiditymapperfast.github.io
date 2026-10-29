/**
 * Asking a System One decision model (a state and typed questions in, typed answers with probabilities out) whether a volatile move is coming:
 * TypeSafe's Jev, or Subquadratic's SubQ Snap, which serves the same `/v1/systemone` contract with a longer context and images. One request
 * per minute carries the digested readings of `volatilityFeatures` and one yes/no question per concept, optionally the raw minute history
 * (`volatilitySeries`) and a heatmap image; the answers are logged with the features so `scripts/volatility-eval.mts` can measure them against what
 * price did next.
 */
import { CONCEPT_IDS, type ConceptId, type VolatilityFeatures } from './features.ts';
import type { ConfluenceReading } from './confluence.ts';

export type DecisionProvider = 'jev' | 'subq';
const PROVIDERS: Record<DecisionProvider, { endpoint: string; model: string }> = {
  jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  subq: { endpoint: 'https://api.subq.ai/v1/systemone', model: 'subq-snap-preview' },
};
const TIMEOUT_MS = 20_000;

/** What one request carries beyond the readings. */
export interface DecisionExtras {
  provider?: DecisionProvider;
  /** The raw minute history as CSV (`volatilitySeries`): long context, SubQ only (it is over Jev's 32K-token state limit). */
  series?: string;
  /** PNG images, base64 without a prefix: SubQ only. */
  images?: { mediaType: 'image/png'; base64: string }[];
}

interface NoulQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
interface ScoreQuestion { type: 'score'; instructions: string; criteria: string[] }
interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion;

const noul = (instructions: string, yes: string, no: string): NoulQuestion => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

/**
 * One yes/no question per concept (docs/volatility-watch.md), then the score and the direction. The id `sharpMove` and the wording are what the
 * models have been asked since 2026-10-17; they are kept so their answers stay comparable.
 */
export const VOLATILITY_QUESTIONS: Record<ConceptId | 'sharpMove' | 'direction', Question> = {
  spotPerpDivergence: noul('Are spot and perpetual traders taking opposite sides strongly enough that the perpetual side could be squeezed?', 'Spot and perpetual flow clearly disagree', 'Spot and perpetual flow agree or are quiet'),
  binanceSpotLeads: noul('Is Binance spot flow pushing against the price move, so that spot looks to be leading and the move looks wrong?', 'Binance spot flow opposes the recent price move', 'Binance spot flow agrees with price or is quiet'),
  priceCvdDivergence: noul('Is price failing to react to the taker flow, or moving against it, in a way that points to an explosive move?', 'Price and flow diverge', 'Price and flow agree'),
  liquidityPulled: noul('Have market makers pulled resting liquidity near price, leaving a void that price could rip through?', 'Liquidity near price has been withdrawn on at least one side', 'Liquidity near price is stable or growing'),
  trackerFlip: noul('Has the balance of resting bids against asks near the touch flipped sides recently?', 'The imbalance changed sign', 'The imbalance kept its side'),
  bookImbalance: noul('Is the book near price unusually skewed to one side?', 'The book is unusually one-sided', 'The book is balanced or ordinary'),
  highlight: noul('Is the last minute of volume or net delta unusually large compared with the previous hour or so?', 'The last minute stands out', 'The last minute is ordinary'),
  liquidationCascade: noul('Are forced liquidations happening at a pace that suggests a cascade is under way or could start?', 'Liquidations are heavy', 'Liquidations are light'),
  leverageBuild: noul('Is leverage building into the current move, so that the next forced wave could be large?', 'Open interest is rising into a move', 'Open interest is flat or falling'),
  whaleVsRetail: noul('Are very large orders trading the opposite way from everyone else, as if large players were moving the market?', 'Large orders oppose the overall flow', 'Large orders agree with the overall flow or are absent'),
  slicer: noul('Does the Binance spot flow look like one automated program buying or selling steadily?', 'A steady automated pattern is visible', 'No steady pattern'),
  sharpMove: { type: 'score', instructions: 'How likely is a sharp price move (several times the usual 15-minute range) in the next 15 minutes?', criteria: ['Very unlikely', 'Unlikely', 'Possible', 'Likely', 'Very likely'] },
  direction: { type: 'choice', instructions: 'If price moves sharply in the next 15 minutes, which way?', criteria: { up: 'Price rises sharply', down: 'Price falls sharply' } },
};

/**
 * The page's warning (`app/sound/alerts.ts`, the Sounds panel's Minimum score by default): Jev's score and its own confidence in it, on a
 * minute when price was not already moving. Jev's score runs lower then than during a move, hence under 3 (Research_Findings.md);
 * `volatility:eval` scores warnings with the same numbers.
 */
export const WARN_MIN_SCORE = 2.5, WARN_MIN_CONFIDENCE = 0.5;

export interface VolatilityVerdict {
  /** The minute judged (ms): the features' time. */
  t: number; coin: string; price: number;
  /** Whether price was already moving at that minute (`VolatilityFeatures.move`): the page warns only when it was not; null when unknown. */
  underway: boolean | null;
  /** Per concept asked: the model's yes probability. */
  concepts: Record<string, number>;
  /** 0 to 4. */
  score: number; scoreConfidence: number;
  direction: 'up' | 'down'; directionP: number;
  model: string;
  /** Round trip (ms) and billed input tokens, when the response reported them. */
  ms?: number; inputTokens?: number;
}

/** The SubQ variants asked beside Jev: the same state, the state plus the raw minute history, the state plus the heatmap image. */
export const SUBQ_ARMS = ['subq', 'subqHistory', 'subqImage'] as const;
export type SubqArm = typeof SUBQ_ARMS[number];

/**
 * What `/api/v2/volatility` answers: whether Jev is asked (and why not), its last error, its newest assessments, the newest model-free confluence
 * readings (`confluence.ts`, made whether or not Jev is asked), both oldest first, and with a SubQ key each arm's newest verdict and error.
 */
export interface VolatilityAnswer {
  enabled: boolean; reason?: string; lastError?: string; coin: string | null; verdicts: VolatilityVerdict[]; confluence?: ConfluenceReading[];
  arms?: Partial<Record<SubqArm, { verdict: VolatilityVerdict | null; lastError?: string }>>;
}

/** What is sent as `state`: the readings in words, the numbers behind them, what they are, and the raw history when given. */
export function volatilityState(features: VolatilityFeatures, extras: DecisionExtras = {}): unknown {
  const notes = ['Each reading is computed from aggregated order books and trades across exchanges.', 'A z-score compares the last window with the same window over the previous 24 hours.'];
  if (extras.series) notes.push('history_csv is the raw minute history (oldest first, UTC): price, net taker flow of spot and perpetuals, gross volume, resting liquidity within 1 % of price (last 6 hours), and liquidations, in thousands of USD.');
  if (extras.images?.length) notes.push('The image is the last 2 hours of resting liquidity around the price, one column a minute, 5 basis points a row: green bids, red asks, brighter is larger; the white line is the price.');
  return {
    market: features.coin,
    time_utc: new Date(features.t).toISOString(),
    price: features.price,
    readings: features.words,
    numbers: features.values,
    ...(extras.series ? { history_csv: extras.series } : {}),
    notes,
  };
}

/** What a response may hold: every field is checked by `typeof` before it is used. */
interface RawAnswer { type?: unknown; noul?: unknown; score?: unknown; confidence?: unknown; probabilities?: { up?: unknown; down?: unknown } | null }
interface RawBody { model?: unknown; answers?: Record<string, RawAnswer | null | undefined> | null; usage?: { input_tokens?: unknown } | null }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const malformed = (): Error => new Error('decision: malformed answer');

/** Check a response body field by field (a type annotation validates nothing about an HTTP body) and read the verdict from it. */
export function readVerdict(body: unknown, features: VolatilityFeatures, asked: readonly string[], fallbackModel = PROVIDERS.jev.model): VolatilityVerdict {
  if (typeof body !== 'object' || body === null) throw malformed();
  const { model, answers, usage } = body as RawBody;
  if (typeof answers !== 'object' || answers === null) throw malformed();
  const concepts: Record<string, number> = {};
  for (const id of asked) {
    const a = answers[id];
    if (!a || a.type !== 'noul' || !finite(a.noul) || a.noul < 0 || a.noul > 1) throw malformed();
    concepts[id] = a.noul;
  }
  const s = answers.sharpMove;
  if (!s || s.type !== 'score' || !finite(s.score) || s.score < 0 || s.score > 4 || !finite(s.confidence)) throw malformed();
  const d = answers.direction;
  if (!d || d.type !== 'choice' || !d.probabilities || !finite(d.probabilities.up) || !finite(d.probabilities.down)) throw malformed();
  const up = d.probabilities.up, down = d.probabilities.down;
  return {
    t: features.t, coin: features.coin, price: features.price, underway: features.move.underway, concepts,
    score: s.score, scoreConfidence: s.confidence,
    direction: up >= down ? 'up' : 'down', directionP: Math.max(up, down),
    model: typeof model === 'string' ? model : fallbackModel,
    ...(usage && finite(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
  };
}

/** Thrown for an HTTP error status, so the watcher can back off on a rate limit. */
export class DecisionHttpError extends Error { constructor(readonly status: number, provider: DecisionProvider) { super(`${provider}: HTTP ${status}`); } }

/** Ask a decision model about one minute. Only the concepts that have a reading are asked: a question about nothing is noise. */
export async function askDecision(features: VolatilityFeatures, apiKey: string, signal?: AbortSignal, extras: DecisionExtras = {}): Promise<VolatilityVerdict> {
  const provider = extras.provider ?? 'jev', { endpoint, model } = PROVIDERS[provider];
  const asked = CONCEPT_IDS.filter(id => features.words[id] !== undefined);
  const questions: Record<string, Question> = { sharpMove: VOLATILITY_QUESTIONS.sharpMove, direction: VOLATILITY_QUESTIONS.direction };
  for (const id of asked) questions[id] = VOLATILITY_QUESTIONS[id];
  const timeout = AbortSignal.timeout(TIMEOUT_MS), started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, state: volatilityState(features, extras), questions, ...(extras.images?.length ? { images: extras.images } : {}) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new DecisionHttpError(response.status, provider);
  let body: unknown;
  try { body = await response.json(); } catch { throw malformed(); }
  return { ...readVerdict(body, features, asked, model), ms: Date.now() - started };
}
