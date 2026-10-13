import { fetchOiHistory, fetchOiReading, venueOf, webGet, type Fetcher, type HistoryListing } from '../../shared/history.ts';
import { unitOf, type CoinVenue } from '../../shared/coins.ts';

/**
 * Open interest of the perpetuals the feed manager does not read (it reads Binance's and Hyperliquid's): Bybit, OKX, Bitget and Deribit,
 * in coins, for the aggregated open interest. Each is read once a minute while its book is live; Bybit's and OKX's history is read first
 * and written straight to the history store (two days at 5 minutes, hourly before that to eight days), so their bars reach back at once;
 * a history read that fails is tried again later (backing off to an hour). Bitget's and Deribit's build up from when sampling starts. A
 * live reading goes through the server's own reducer as Binance's does, so the OI route answers it with the stored bars.
 */
export const SAMPLED_OI_VENUES: readonly string[] = ['bybit', 'okx', 'bitget', 'deribit'];
export const OI_SAMPLE_MS = 60_000;
/** History read at start: five-minute bars this far back, hourly ones before them to `HISTORY_HOURLY_MS`. */
const HISTORY_FINE_MS = 2 * 86_400_000, HISTORY_HOURLY_MS = 8 * 86_400_000;
/** History rows written to the store per turn of the event loop. */
const ROWS_PER_TURN = 200;
/** A failed history read is tried again after a minute, doubling to at most an hour. */
const RETRY_MS = 60_000, RETRY_MAX_MS = 3_600_000;

export interface OiSampleMessage { kind: 'openInterest'; instrumentId: string; sourceTimestamp: number | null; observationTimestamp?: number; receivedAt: number; base: number; quality: 'native' | 'sampled'; source?: string }

/**
 * How a perpetual lists its coin, from its own instrument id (`venue:SYMBOL`): its symbol, its unit as the coin list reads it (1000PEPEUSDT and
 * Bybit's SHIB1000USDT count thousands), and Deribit's coin-margined perpetuals (BTC-PERPETUAL, ETH-PERPETUAL; the X_USDC-PERPETUAL ones are linear). Null for an
 * id that names no single perpetual (a spot market's `:spot` suffix).
 */
export function oiListingOf(id: string): HistoryListing | null {
  const parts = id.split(':'); if (parts.length !== 2 || !parts[1]) return null;
  const [venue, symbol] = parts as [string, string];
  // The market's name for the base, then its unit as the coin list reads it (1000PEPE, Bybit's SHIB1000).
  const base = venue === 'okx' ? symbol.split('-')[0]! : venue === 'deribit' ? symbol.replace(/-PERPETUAL$/, '').replace(/_USDC$/, '') : symbol.replace(/(USDT|USDC)$/, '');
  return { symbol, unit: unitOf(base, venue as CoinVenue)[1], ...(venue === 'deribit' && /^[A-Z]+-PERPETUAL$/.test(symbol) ? { inverse: true } : {}) };
}

export class OiSampler {
  #ids: string[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null; #closed = false;
  /** Each instrument's history: read, or when to try again and how many times it failed. */
  readonly #history = new Map<string, { done: boolean; tries: number; nextAt: number }>();

  /**
   * `apply` hands a live reading to the server's reducer; `record` writes a history row to the store. `get` and `now` are the network and
   * the clock (tests pass fakes).
   */
  constructor(private apply: (message: OiSampleMessage, venue: string) => void, private record: (message: OiSampleMessage) => void,
    private get: Fetcher = webGet, private now: () => number = Date.now, private everyMs = OI_SAMPLE_MS) {}

  /** The perpetuals whose book is live: those of the sampled venues are read from now on, the others are let go. */
  sync(ids: readonly string[]): void {
    if (this.#closed) return;
    this.#ids = [...new Set(ids.filter(id => SAMPLED_OI_VENUES.includes(venueOf(id)) && oiListingOf(id) !== null))].sort();
    if (this.#ids.length && !this.#timer) {
      this.#timer = setInterval(() => { void this.round(); }, this.everyMs);
      this.#timer.unref?.();
      void this.round();
    } else if (!this.#ids.length && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  /** One reading of every instrument (after its history, when due); a round under way is the one returned. The timer calls it. */
  round(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#running ??= this.#round().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #round(): Promise<void> {
    for (const id of this.#ids) {
      const venue = venueOf(id), listing = oiListingOf(id)!;
      const history = this.#history.get(id) ?? { done: false, tries: 0, nextAt: 0 };
      this.#history.set(id, history);
      if (!history.done && this.now() >= history.nextAt) {
        try { await this.#readHistory(id, venue, listing); history.done = true; }
        catch { history.tries++; history.nextAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (history.tries - 1)); }
      }
      if (this.#closed) return;
      // An inverse market's reading keeps its own USD too (`quote`): the coins alone move with the price.
      const reading = await fetchOiReading(venue, this.get, listing).catch(() => null);
      if (reading !== null && !this.#closed) this.apply({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt: this.now(), base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}), quality: 'sampled', source: `${venue}-openInterest` }, venue);
    }
  }

  /** The venue's history, oldest first, written to the store a few hundred rows a turn; throws when the venue could not be read. */
  async #readHistory(id: string, venue: string, listing: HistoryListing): Promise<void> {
    const now = this.now();
    const hourly = await fetchOiHistory(id, 3_600_000, now - HISTORY_HOURLY_MS, now - HISTORY_FINE_MS, this.get, listing);
    const fine = await fetchOiHistory(id, 300_000, now - HISTORY_FINE_MS, now, this.get, listing);
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
