import { fetchOiHistory, fetchOiSample, venueOf, webGet, type Fetcher } from '../../shared/history.ts';

/**
 * Open interest of the perpetuals the feed manager does not read (it reads Binance's and Hyperliquid's): Bybit, OKX, Bitget and Deribit,
 * in coins, for the aggregated open interest. Each is read once a minute while its book is live; Bybit's and OKX's history is read once
 * first and written straight to the history store (7 days at 5 minutes where the venue keeps them, hourly before), so their bars reach
 * back at once; Bitget's and Deribit's build up from when sampling starts. A reading goes through the server's own reducer as Binance's
 * does, so the OI route answers it with the stored bars.
 */
export const SAMPLED_OI_VENUES: readonly string[] = ['bybit', 'okx', 'bitget', 'deribit'];
export const OI_SAMPLE_MS = 60_000;
/** History read at start: five-minute bars this far back, hourly ones before them to `HISTORY_HOURLY_MS`. */
const HISTORY_FINE_MS = 2 * 86_400_000, HISTORY_HOURLY_MS = 8 * 86_400_000;
/** History rows written to the store per turn of the event loop. */
const ROWS_PER_TURN = 200;

export interface OiSampleMessage { kind: 'openInterest'; instrumentId: string; sourceTimestamp: number | null; observationTimestamp?: number; receivedAt: number; base: number; quality: 'native' | 'sampled'; source?: string }

export class OiSampler {
  #ids: string[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null; #closed = false;
  readonly #backfilled = new Set<string>();

  /**
   * `apply` hands a live reading to the server's reducer; `record` writes a history row to the store. `get` and `now` are the network and
   * the clock (tests pass fakes).
   */
  constructor(private apply: (message: OiSampleMessage, venue: string) => void, private record: (message: OiSampleMessage) => void,
    private get: Fetcher = webGet, private now: () => number = Date.now, private everyMs = OI_SAMPLE_MS) {}

  /** The instruments whose book is live: those of the sampled venues are read from now on, the others are let go. */
  sync(ids: readonly string[]): void {
    if (this.#closed) return;
    this.#ids = [...new Set(ids.filter(id => SAMPLED_OI_VENUES.includes(venueOf(id))))].sort();
    if (this.#ids.length && !this.#timer) {
      this.#timer = setInterval(() => { void this.round(); }, this.everyMs);
      this.#timer.unref?.();
      void this.round();
    } else if (!this.#ids.length && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  /** One reading of every instrument (after its history, the first time); a round under way is the one returned. The timer calls it. */
  round(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#running ??= this.#round().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #round(): Promise<void> {
    for (const id of this.#ids) {
      const venue = venueOf(id);
      if (!this.#backfilled.has(id)) { this.#backfilled.add(id); await this.#history(id, venue); }
      if (this.#closed) return;
      const coins = await fetchOiSample(venue, this.get).catch(() => null);
      if (coins !== null && !this.#closed) this.apply({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt: this.now(), base: coins, quality: 'sampled', source: `${venue}-openInterest` }, venue);
    }
  }

  /** The venue's history, oldest first, written to the store a few hundred rows a turn (before any live reading, so none is older than one held). */
  async #history(id: string, venue: string): Promise<void> {
    const now = this.now();
    const hourly = await fetchOiHistory(id, 3_600_000, now - HISTORY_HOURLY_MS, now - HISTORY_FINE_MS, this.get).catch(() => []);
    const fine = await fetchOiHistory(id, 300_000, now - HISTORY_FINE_MS, now, this.get).catch(() => []);
    const firstFine = fine.length ? Number(fine[0]!.start) : Infinity;
    const rows = [...hourly.filter(r => Number(r.start) < firstFine), ...fine];
    for (let i = 0; i < rows.length; i += ROWS_PER_TURN) {
      if (this.#closed) return;
      for (const r of rows.slice(i, i + ROWS_PER_TURN)) {
        const t = Number(r.start);
        this.record({ kind: 'openInterest', instrumentId: id, sourceTimestamp: t, observationTimestamp: t, receivedAt: now, base: Number(r.close), quality: 'sampled', source: `${venue}-openInterestHistory` });
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  close(): void { this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
}
