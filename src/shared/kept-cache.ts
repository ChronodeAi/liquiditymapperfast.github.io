/**
 * An entry asked within this long is not let go to make room: the page asks its whole window again every 30 s, and an answer can take a few
 * seconds. After a zoom, what the view before it asked is let go this long after its last refresh, so the new view is kept from its first
 * or second refresh on; a tab in the background, which a browser lets refresh once a minute, does not hold on to its share.
 */
export const PROTECT_MS = 45_000;

/**
 * What a recorder keeps for the next question (merged windows, hours read back from the store), up to a total weight, least recently asked
 * first.
 *
 * Two rules make it hold up when a page asks again and again for more than it can hold (the page asks its whole window every 30 s, and a
 * two-day view of every BTC market is more merged windows than the server keeps):
 * - An entry asked within PROTECT_MS is not let go to make room; the new one is then not kept. A refresh so finds what it found last time and
 *   merges or reads only the rest, where letting the oldest go would push out each window just before it is asked again and keep nothing.
 * - Room is made in one go, down to seven eighths of the limit. A Map walked from its oldest entry steps over every entry deleted since it
 *   was last rebuilt, so letting one go per entry kept cost some 20 µs an entry: a second of a two-day view's refresh (measured 2026-10-12).
 */
export class KeptCache<V> {
  readonly #entries = new Map<string, { value: V; weight: number; at: number }>();
  readonly #limit: number;
  readonly #now: () => number;
  #weight = 0;
  /** Until when every entry is too recently asked to let go: nothing new is kept meanwhile once full, without walking the entries again. */
  #fullUntil = -Infinity;

  constructor(limit: number, now: () => number) { this.#limit = limit; this.#now = now; }

  /** How many entries are kept, and their total weight. */
  get size(): number { return this.#entries.size; }
  get weight(): number { return this.#weight; }

  /** The entry under `key`, which is now the most recently asked. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key); entry.at = this.#now(); this.#entries.set(key, entry);
    return entry.value;
  }

  /** Whether an entry is kept under `key` (it is not counted as asked). */
  has(key: string): boolean { return this.#entries.has(key); }

  /** Keep `value` under `key` (in place of what was), if there is room or room can be made from entries not asked for PROTECT_MS. */
  set(key: string, value: V, weight: number): void {
    this.delete(key);
    if (weight > this.#limit) return;
    const now = this.#now();
    if (this.#weight + weight > this.#limit) {
      if (now < this.#fullUntil) return;
      const target = Math.min(this.#limit - weight, this.#limit - this.#limit / 8);
      for (const [oldest, entry] of this.#entries) {
        if (this.#weight <= target) break;
        if (entry.at > now - PROTECT_MS) { this.#fullUntil = entry.at + PROTECT_MS; break; }
        this.#entries.delete(oldest); this.#weight -= entry.weight;
      }
      if (this.#weight + weight > this.#limit) return;
    }
    this.#entries.set(key, { value, weight, at: now }); this.#weight += weight;
  }

  /** Let go of the entry under `key`. */
  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) { this.#entries.delete(key); this.#weight -= entry.weight; }
  }

  /** Let go of every entry `test` picks. */
  deleteWhere(test: (key: string, value: V) => boolean): void {
    for (const [key, entry] of this.#entries) if (test(key, entry.value)) { this.#entries.delete(key); this.#weight -= entry.weight; }
  }
}
