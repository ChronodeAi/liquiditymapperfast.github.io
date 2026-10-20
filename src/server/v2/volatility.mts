import fs from 'node:fs';
import path from 'node:path';
import { volatilityFeatures, volatilitySeries, HEAT_ROW_BP, type VolatilityFeatures, type VolatilityInputs } from '../../shared/volatility/features.ts';
import { confluence, type ConfluenceReading } from '../../shared/volatility/confluence.ts';
import { askDecision, DecisionHttpError, SUBQ_ARMS, type DecisionExtras, type SubqArm, type VolatilityAnswer, type VolatilityVerdict } from '../../shared/volatility/jev.ts';
import { heatPng } from './volatility-image.mts';

/** Once a minute, at this many ms past it: the flow recorder has closed the minute by then. */
const OFFSET_MS = 15_000;
const MINUTE = 60_000;
const KEEP = 120;
const LOG_MAX_BYTES = 50 * 1024 * 1024;
const WARN_EVERY_MS = 3_600_000;
const BACKOFF_MS = 5 * MINUTE;

export interface VolatilityWatchOptions {
  /** Where `volatility-log.jsonl` goes; null keeps nothing on disk. */
  dir: string | null;
  /** Gathers the inputs for the minute that ends at `now`, or null when the server has nothing for the coin yet. */
  read(now: number): VolatilityInputs | null;
  /** The Jev key; absent: the confluence is still read and logged every minute, Jev is not asked. */
  apiKey?: string;
  /** The SubQ key; present: the SubQ arms (`subqArms`) are asked beside Jev every minute, in shadow. */
  subqKey?: string;
  /** The SubQ arms asked (`subqArmsFrom`, the `SUBQ_ARMS` environment variable); absent: all of `SUBQ_ARMS`. An arm left out is paused. */
  subqArms?: readonly SubqArm[];
  ask?: typeof askDecision;
  clock?: () => number;
}

/**
 * Once a minute reads the model-free confluence (shared/volatility/confluence.ts) and, with keys, asks Jev and the SubQ arms whether a volatile move is
 * coming (docs/volatility-watch.md). Every minute is kept (the last 120 in memory, all of them in `volatility-log.jsonl` beside the recording, not in
 * the history store, which has a hard size budget) with the readings behind it.
 */
export class VolatilityWatch {
  readonly #options: VolatilityWatchOptions;
  readonly #ask: typeof askDecision;
  readonly #now: () => number;
  readonly #ring: VolatilityVerdict[] = [];
  readonly #confluence: ConfluenceReading[] = [];
  readonly #warned = new Map<string, number>();
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  #backoffUntil = 0;
  #lastError: string | undefined;
  #coin: string | null = null;
  #logBytes = 0;
  #stopped = false;
  /** Per SubQ arm: its newest verdict, last error and back-off. */
  readonly #arms = new Map<SubqArm, { verdict: VolatilityVerdict | null; lastError?: string; backoffUntil: number }>();

  constructor(options: VolatilityWatchOptions) {
    this.#options = options; this.#ask = options.ask ?? askDecision; this.#now = options.clock ?? Date.now;
    if (options.dir) {
      try { fs.mkdirSync(options.dir, { recursive: true }); this.#logBytes = fs.existsSync(this.#logPath()) ? fs.statSync(this.#logPath()).size : 0; } catch (error) { this.#warn(`log unavailable: ${(error as Error).message}`); }
    }
  }

  #logPath(): string { return path.join(this.#options.dir!, 'volatility-log.jsonl'); }

  /** Whether Jev is asked. */
  get enabled(): boolean { return Boolean(this.#options.apiKey); }

  answer(): VolatilityAnswer {
    const confluence = [...this.#confluence];
    const arms = this.#options.subqKey ? { arms: Object.fromEntries([...this.#arms].map(([id, a]) => [id, { verdict: a.verdict, ...(a.lastError ? { lastError: a.lastError } : {}) }])) } : {};
    if (!this.enabled) return { enabled: false, reason: 'TYPESAFE_API_KEY is not set', coin: this.#coin, verdicts: [], confluence, ...arms };
    return { enabled: true, ...(this.#lastError ? { lastError: this.#lastError } : {}), coin: this.#coin, verdicts: [...this.#ring], confluence, ...arms };
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    const schedule = (): void => {
      if (this.#stopped) return;
      const now = this.#now(), next = Math.floor((now - OFFSET_MS) / MINUTE) * MINUTE + MINUTE + OFFSET_MS;
      this.#timer = setTimeout(() => { this.#timer = null; schedule(); void this.tick(); }, Math.max(1, next - now));
      this.#timer.unref();
    };
    schedule();
  }

  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
  }

  /**
   * One reading of the minute that has just ended: the confluence always, Jev's assessment and the SubQ arms' with their keys, all at once.
   * Skipped while the last is still in flight; a model backing off is skipped, the rest still run. The minute is logged once, with each
   * model's verdict when it answered.
   */
  async tick(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    try {
      const now = Math.floor(this.#now() / MINUTE) * MINUTE;
      const inputs = this.#options.read(now);
      if (!inputs) return this.#fail('no recorded data for the coin yet');
      this.#coin = inputs.coin;
      const features = volatilityFeatures(inputs);
      if (!features) return this.#fail('no price or no flow for the coin yet');
      if (!Object.keys(features.words).length) return this.#fail('no readings yet');
      const reading: ConfluenceReading = { t: features.t, coin: features.coin, price: features.price, ...confluence(features.values) };
      this.#confluence.push(reading); if (this.#confluence.length > KEEP) this.#confluence.shift();
      const jev = this.enabled && this.#now() >= this.#backoffUntil ? this.#askJev(features) : Promise.resolve(undefined);
      const [verdict, arms] = await Promise.all([jev, this.#askArms(features, inputs)]);
      if (this.#stopped) return;
      this.#append({ features, confluence: reading, ...(verdict ? { verdict } : {}), ...(Object.keys(arms).length ? { arms } : {}) });
    } catch (error) {
      if (this.#stopped) return;
      this.#fail((error as Error).message || String(error));
    } finally { this.#busy = false; }
  }

  async #askJev(features: VolatilityFeatures): Promise<VolatilityVerdict | undefined> {
    try {
      const verdict = await this.#ask(features, this.#options.apiKey!, this.#abort.signal);
      this.#lastError = undefined; this.#backoffUntil = 0;
      this.#ring.push(verdict); if (this.#ring.length > KEEP) this.#ring.shift();
      return verdict;
    } catch (error) {
      if (this.#stopped) return undefined;
      if (error instanceof DecisionHttpError && error.status === 429) this.#backoffUntil = this.#now() + BACKOFF_MS;
      this.#fail((error as Error).message || String(error));
      return undefined;
    }
  }

  /**
   * The SubQ arms asked that are not backing off, in parallel: plain, with the raw history, with the heatmap image. A paused arm is not
   * asked and its extra input is not built.
   */
  async #askArms(features: VolatilityFeatures, inputs: VolatilityInputs): Promise<Partial<Record<SubqArm, VolatilityVerdict>>> {
    const key = this.#options.subqKey;
    if (!key) return {};
    const asked = this.#options.subqArms ?? SUBQ_ARMS;
    const series = asked.includes('subqHistory') ? volatilitySeries(inputs) ?? undefined : undefined;
    const png = asked.includes('subqImage') && inputs.heat ? heatPng(inputs.heat, HEAT_ROW_BP) : null;
    const extrasOf: Record<SubqArm, DecisionExtras | null> = {
      subq: { provider: 'subq' },
      subqHistory: series ? { provider: 'subq', series } : null,
      subqImage: png ? { provider: 'subq', images: [{ mediaType: 'image/png', base64: png.toString('base64') }] } : null,
    };
    const out: Partial<Record<SubqArm, VolatilityVerdict>> = {};
    await Promise.all(asked.map(async id => {
      const arm = this.#arms.get(id) ?? { verdict: null, backoffUntil: 0 };
      this.#arms.set(id, arm);
      const extras = extrasOf[id];
      if (!extras) { arm.lastError = id === 'subqImage' ? 'no heatmap yet' : 'no history yet'; return; }
      if (this.#now() < arm.backoffUntil) return;
      try {
        const verdict = await this.#ask(features, key, this.#abort.signal, extras);
        arm.verdict = verdict; arm.lastError = undefined; arm.backoffUntil = 0; out[id] = verdict;
      } catch (error) {
        if (this.#stopped) return;
        if (error instanceof DecisionHttpError && error.status === 429) arm.backoffUntil = this.#now() + BACKOFF_MS;
        arm.lastError = (error as Error).message || String(error);
        this.#warn(`${id}: ${arm.lastError}`);
      }
    }));
    return out;
  }

  #fail(message: string): void { this.#lastError = message; this.#warn(message); }

  /** At most one line per distinct message an hour. */
  #warn(message: string): void {
    const now = this.#now(), at = this.#warned.get(message);
    if (at !== undefined && now - at < WARN_EVERY_MS) return;
    this.#warned.set(message, now);
    console.warn(`volatility: ${message}`);
  }

  #append(row: unknown): void {
    if (!this.#options.dir) return;
    try {
      const line = JSON.stringify(row) + '\n';
      if (this.#logBytes + line.length > LOG_MAX_BYTES) { fs.renameSync(this.#logPath(), path.join(this.#options.dir, 'volatility-log.1.jsonl')); this.#logBytes = 0; }
      fs.appendFileSync(this.#logPath(), line); this.#logBytes += Buffer.byteLength(line);
    } catch (error) { this.#warn(`log write failed: ${(error as Error).message}`); }
  }
}

/**
 * The SubQ arms named in `text`, a comma-separated list (the `SUBQ_ARMS` environment variable), and the names in it that are no arm.
 * Absent: every arm; empty: none.
 */
export function subqArmsFrom(text: string | undefined): { arms: SubqArm[]; unknown: string[] } {
  if (text === undefined) return { arms: [...SUBQ_ARMS], unknown: [] };
  const names = text.split(',').map(name => name.trim()).filter(Boolean);
  return { arms: SUBQ_ARMS.filter(id => names.includes(id)), unknown: names.filter(name => !SUBQ_ARMS.some(id => id === name)) };
}
