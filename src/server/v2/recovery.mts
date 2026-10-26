import fs from 'node:fs';
import { BTC, type Coin, type MarketVenue } from '../../shared/coins.ts';
import { complement, firstEndingAfter, union, type CoverGap, type SeamTrade } from '../../shared/coverage.ts';
import type { FlowRecorder } from '../../shared/flow.ts';
import type { FootprintRecorder } from '../../shared/footprint.ts';
import { venueOf } from '../../shared/history.ts';
import { RETENTION_MS } from '../../shared/recorder.ts';
import { RECOVERY_BUDGET, applyRecovered, historySource, recoverableGaps, runRecovery, webHistoryFetch, type HistoryFetch, type HistorySource, type RecoveryBudget, type RecoveryJob, type RecoveryRecordings, type RecoveryResult } from '../../shared/recovery.ts';

/**
 * The server's trade recovery: the gaps its coverage record holds (a restart, a feed reconnecting, a network outage, a loop that stalled)
 * filled from the venues' public trade history with the browser engine's own recovery (shared/recovery.ts: the seam, the budget, the
 * venues' limits, `applyRecovered`), in the background:
 *
 *  - for the first minutes after a start, only the gaps the restart left, each as soon as its instrument's live stretch is open again (the
 *    feeds take 20 to 60 s to return), the venues that read only their newest page first, since that page moves on;
 *  - then every gap between two stretches of the retention, newest first, one action of RECOVERY_BUDGET at a time and a rest between
 *    actions, so a week's backlog is worked through over hours without straining venues the server also reads open interest, candles and
 *    prices from.
 *
 * A gap a venue cannot fill is asked once or a few times, never again and again: Deribit and MEXC have no history (never asked), Bybit and
 * Hyperliquid only their newest page (a gap is asked once, and only while it is recent), a gap a history answered without reaching is
 * given up after a few tries, and a limit that fails rests, longer each time. What was given up is kept in `file`, so a restart does not
 * ask it again; what was recovered is a `recovered` stretch of the coverage record, stored with the minutes it filled, so it is never a
 * gap again (no double counting across a restart).
 */

/** The rest between two actions while there is work, and the look for new gaps when there is none. */
const REST_MS = 20_000, IDLE_MS = 60_000;
/** After a start: how long only the restart's gaps are recovered, and how often it looks for instruments whose feed has come back meanwhile. */
const START_MS = 120_000, START_LOOK_MS = 2_000;
/** A venue that reads only its newest page is asked for a gap only while it ended this recently (its page reaches back seconds to minutes). */
const LATEST_REACH_MS = 10 * 60_000;
/** A gap a history answered for this many times without covering any of it is given up. */
const MAX_TRIES = 3;
/** A limit (`HistorySource.bucket`) whose venue failed rests this long, twice as long after each further failure, up to the last. */
const FIRST_REST_MS = 60_000, LONGEST_REST_MS = 30 * 60_000;
/** The gaps one action is given (it stops at its budget), and how far inside the retention a gap must be (its minutes are about to go). */
const JOBS_PER_ACTION = 60, RETENTION_MARGIN_MS = 3_600_000;
const LOG_EVERY_MS = 3_600_000, SECOND = 1_000, MINUTE = 60_000;

/** Why a gap is not asked for again. */
type GiveUp = 'out of reach' | 'not in the history' | 'recorded live';
interface GivenUp { id: string; from: number; to: number; why: GiveUp }

export interface TradeRecoveryStatus {
  state: 'starting' | 'recovering' | 'resting' | 'idle' | 'closed';
  startedAt: number;
  /** The gaps left to recover at the last look, and how much of the time they span. */
  backlog: { gaps: number; ms: number; instruments: Record<string, { gaps: number; ms: number }> };
  /** The newest action: when, what it read and took, what it filled, what stopped it, and the limits that failed. */
  last: { at: number; ms: number; gaps: number; pages: number; rows: number; trades: number; recoveredMs: number; stoppedBy: string; failed: string[] } | null;
  totals: { actions: number; pages: number; rows: number; trades: number; recoveredMs: number; failures: number };
  /** Limits resting after a failure, until when. */
  resting: Record<string, number>;
  givenUp: { gaps: number; ms: number };
  /** Instruments recorded whose venue has no trade history to read (Deribit, MEXC). */
  noHistory: string[];
}

export interface TradeRecoveryOptions {
  recordings: RecoveryRecordings & { flows: Pick<FlowRecorder, 'ingest' | 'firstRecorded'>; footprints: Pick<FootprintRecorder, 'ingest' | 'countOrders' | 'holds' | 'instruments' | 'lastMinute'> };
  /** Where what was given up is kept (null: memory only). */
  file?: string | null;
  fetch?: HistoryFetch; budget?: RecoveryBudget; now?: () => number; coin?: Coin; retentionMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * How the server names a venue's trades where its history names them otherwise: the feed manager names Binance USD-M's aggregate trades
 * `<symbol>:<id>` (adapters/binance.mts), the history just `<id>`. Which an instrument uses is read from its own seams.
 */
interface Names { toVenue(id: string): string; fromVenue(id: string): string }
function namesOf(spans: readonly { kind: string; first?: SeamTrade; last?: SeamTrade }[], symbol: string): Names {
  const prefix = `${symbol}:`, live = spans.filter(s => s.kind === 'live').flatMap(s => [s.first?.id, s.last?.id]).find((id): id is string => !!id);
  const used = live !== undefined && live.startsWith(prefix) && /^\d+$/.test(live.slice(prefix.length)) ? prefix : '';
  return { toVenue: id => used && id.startsWith(used) ? id.slice(used.length) : id, fromVenue: id => used + id };
}

/** `gap` without the stretches of `cut` (merged, ordered), each piece keeping a seam only where it is the gap's own edge. */
function without(gap: CoverGap, cut: readonly (readonly [number, number])[]): CoverGap[] {
  // Only the stretches reaching into the gap: thousands may be given up over a week, and this is asked of every gap.
  const lo = firstEndingAfter(cut, gap.from);
  let hi = lo; while (hi < cut.length && cut[hi]![0] < gap.to) hi++;
  if (hi === lo) return [gap];
  return complement(cut.slice(lo, hi), gap.from, gap.to).map(([a, b]) => ({ from: a, to: b, before: a === gap.from ? gap.before : null, after: b === gap.to ? gap.after : null }));
}

/** A job as planned: the claim it may make (up to `claimTo`) and the rows it may keep (stamped in [keepFrom, keepTo)); see `#trim`. */
interface Planned { job: RecoveryJob; names: Names; claimTo: number; keepFrom: number; keepTo: number }

export class TradeRecovery {
  readonly #recordings: TradeRecoveryOptions['recordings'];
  readonly #file: string | null;
  readonly #fetch: HistoryFetch;
  readonly #budget: RecoveryBudget;
  readonly #now: () => number;
  readonly #coin: Coin;
  readonly #retentionMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #startedAt: number;
  /** The end of the newest footprint minute each instrument had at the start (read from storage): `recoverableGaps`'s unknown minutes. */
  readonly #loadedThrough = new Map<string, number>();
  readonly #givenUp: GivenUp[] = [];
  /** Whether `#givenUp` changed since it was last written (it grows to thousands over a week: not written again after every action). */
  #givenUpChanged = false;
  /** Answered tries of a gap (by instrument, start and end) that covered none of it. */
  readonly #tries = new Map<string, number>();
  readonly #rest = new Map<string, { until: number; ms: number }>();
  readonly #abort = new AbortController();
  #running: Promise<void> | null = null;
  #nextAt: number;
  #closed = false;
  #status: Omit<TradeRecoveryStatus, 'state' | 'resting' | 'givenUp'>;
  #startLogged = false; #lastLog: number;
  #hour = { gaps: 0, recoveredMs: 0, pages: 0, trades: 0, failed: new Set<string>() };

  constructor({ recordings, file = null, fetch = webHistoryFetch, budget = RECOVERY_BUDGET, now = Date.now, coin = BTC, retentionMs = RETENTION_MS, sleep, log = line => console.log(line) }: TradeRecoveryOptions) {
    this.#recordings = recordings; this.#file = file; this.#fetch = fetch; this.#budget = budget; this.#now = now; this.#coin = coin; this.#retentionMs = retentionMs; this.#log = log;
    // Its timers never keep the process alive, and stop at once when it closes.
    this.#sleep = sleep ?? (ms => new Promise<void>(resolve => { if (this.#closed) { resolve(); return; } setTimeout(resolve, ms).unref(); }));
    this.#startedAt = now(); this.#nextAt = this.#startedAt; this.#lastLog = this.#startedAt;
    for (const id of recordings.footprints.instruments) this.#loadedThrough.set(id, recordings.footprints.lastMinute(id) + MINUTE);
    this.#status = { startedAt: this.#startedAt, backlog: { gaps: 0, ms: 0, instruments: {} }, last: null, totals: { actions: 0, pages: 0, rows: 0, trades: 0, recoveredMs: 0, failures: 0 }, noHistory: [] };
    if (file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { givenUp?: unknown };
        const kept = now() - retentionMs;
        if (Array.isArray(saved.givenUp)) for (const g of saved.givenUp as Partial<GivenUp>[]) {
          if (typeof g?.id === 'string' && Number.isFinite(g.from) && Number.isFinite(g.to) && g.to! > g.from! && g.to! >= kept && (g.why === 'out of reach' || g.why === 'not in the history' || g.why === 'recorded live')) this.#givenUp.push({ id: g.id, from: g.from!, to: g.to!, why: g.why });
        }
      } catch { /* none kept yet, or unreadable: every gap may be asked once more */ }
    }
  }

  /** One pass of the server's loop: an action begins when none is running and its rest is over. */
  poll(now = this.#now()): void {
    if (this.#closed || this.#running || now < this.#nextAt) return;
    this.#running = this.#action().catch(error => { console.error('trade recovery failed; carrying on:', error); this.#nextAt = this.#now() + IDLE_MS; }).finally(() => { this.#running = null; });
  }

  /** The action under way, if any (a test waits for it). */
  get running(): Promise<void> | null { return this.#running; }

  status(): TradeRecoveryStatus {
    const now = this.#now(), resting: Record<string, number> = {};
    for (const [bucket, rest] of this.#rest) if (rest.until > now) resting[bucket] = rest.until;
    const state = this.#closed ? 'closed' : this.#running ? 'recovering' : now - this.#startedAt < START_MS ? 'starting' : this.#status.backlog.gaps ? 'resting' : 'idle';
    return { ...this.#status, state, resting, givenUp: { gaps: this.#givenUp.length, ms: this.#givenUp.reduce((sum, g) => sum + g.to - g.from, 0) } };
  }

  close(): void { this.#closed = true; this.#abort.abort(); this.#save(); }

  /**
   * The history source of an instrument the server records (none: not this coin's market, a venue with no history, or another market of
   * the venue than the one its history reads: an id of more than `<venue>:<symbol>`, such as `binance:BTCUSDT:spot`).
   */
  #sourceOf(id: string): HistorySource | null {
    const listing = this.#coin.markets[venueOf(id) as MarketVenue];
    return listing && id.split(':').length === 2 ? historySource(venueOf(id), listing) : null;
  }

  /** Every gap worth asking for now, newest first (in the first minutes after a start, the restart's only, the newest-page venues first). */
  #plan(now: number): Planned[] {
    const { coverage } = this.#recordings, starting = now - this.#startedAt < START_MS, noHistory: string[] = [];
    const backlog: TradeRecoveryStatus['backlog'] = { gaps: 0, ms: 0, instruments: {} };
    const candidates: { piece: CoverGap; whole: CoverGap; later: SeamTrade | null; id: string; source: HistorySource; names: Names }[] = [];
    for (const id of coverage.instruments) {
      const source = this.#sourceOf(id);
      if (!source) { noHistory.push(id); continue; }
      const spans = coverage.spans(id); if (!spans.length) continue;
      // Only between two stretches: before the first the recording had not begun, and after an instrument's newest one (its feed is not
      // back) the gap has no end yet. In the first minutes after a start, only the restart's gap (a look every START_LOOK_MS over the whole
      // week held the server's loop up to a second each time), from a minute before the run before stopped: a gap at the window's edge has no
      // seam, and its first second, holding the last trades before it, was taken for trades recorded inside it (2026-10-26).
      let from = Math.max(spans[0]!.from, now - this.#retentionMs + RETENTION_MARGIN_MS);
      if (starting) from = Math.max(from, ...spans.filter(s => s.from < this.#startedAt).map(s => s.to - MINUTE));
      const end = coverage.openTo(id) ?? Math.max(...spans.map(s => s.to));
      if (!(end > from)) continue;
      const given = union(this.#givenUp.filter(g => g.id === id), from, end);
      const names = namesOf(spans, this.#coin.markets[venueOf(id) as MarketVenue]!.symbol);
      for (const whole of recoverableGaps(this.#recordings, id, from, end, this.#loadedThrough.get(id) ?? 0)) {
        // A venue that pages back starts from a trade after the gap: its own seam, or the first trade of a later stretch (the stretches are
        // ordered by start: found by halving).
        let later = whole.after;
        if (!later) {
          let at = 0, hi = spans.length;
          while (at < hi) { const mid = (at + hi) >> 1; if (spans[mid]!.from < whole.to) at = mid + 1; else hi = mid; }
          while (at < spans.length && !spans[at]!.first) at++;
          later = spans[at]?.first ?? null;
        }
        for (const piece of without(whole, given)) {
          if (source.mode === 'latest' && piece.to < now - LATEST_REACH_MS) continue;
          const sum = backlog.instruments[id] ??= { gaps: 0, ms: 0 };
          sum.gaps++; sum.ms += piece.to - piece.from; backlog.gaps++; backlog.ms += piece.to - piece.from;
          if (starting && piece.to < this.#startedAt) continue;
          if ((this.#rest.get(source.bucket)?.until ?? 0) > now) continue;
          candidates.push({ piece, whole, later, id, source, names });
        }
      }
    }
    this.#status.backlog = backlog; this.#status.noHistory = noHistory;
    candidates.sort(starting ? (a, b) => Number(b.source.mode === 'latest') - Number(a.source.mode === 'latest') || b.piece.to - a.piece.to : (a, b) => b.piece.to - a.piece.to);
    const planned: Planned[] = [];
    for (const { piece, whole, later, id, source, names } of candidates) {
      if (planned.length >= JOBS_PER_ACTION) break;
      const trimmed = this.#trim(id, piece, whole.to < this.#startedAt);
      if (!trimmed) continue;
      // The job runs to the whole gap's end and its seams (a piece cut out of it has none of its own), and keeps only the rows it may.
      const seam = (s: SeamTrade | null): SeamTrade | null => s ? { id: names.toVenue(s.id), t: s.t } : null;
      const after = source.mode === 'back' ? later : whole.after;
      planned.push({ job: { id, source, window: 0, from: piece.from, to: whole.to, before: seam(piece.before), after: seam(after) }, names, ...trimmed });
    }
    return planned;
  }

  /**
   * What of a piece may be recovered. Where the live recording holds trades inside it that no seam names (a frozen loop's sockets handing
   * on what they held as it woke, a reconnected feed's first trades before the next pass), from the first second with a trade recorded
   * the recording holds what the venue sent, and recovering it would count it twice: that part is given up and not claimed. A gap of an
   * earlier run (`older`) is joined by time at its seams' seconds as well, since the ids of its trades left with that run: no row is kept
   * from the second of the first trade after it, nor, when the recording holds trades inside it, from the second of the last one before.
   * Null: nothing to recover (or the recording could not be read).
   */
  #trim(id: string, piece: CoverGap, older: boolean): Pick<Planned, 'claimTo' | 'keepFrom' | 'keepTo'> | null {
    const lo = Math.max(piece.from, piece.before ? Math.floor(piece.before.t / SECOND) * SECOND + SECOND : piece.from);
    const hi = Math.min(piece.to, piece.after ? Math.floor(piece.after.t / SECOND) * SECOND : piece.to);
    let first: number | null = null;
    try { first = hi > lo ? this.#recordings.flows.firstRecorded(id, lo, hi) : null; } catch { return null; }
    const claimTo = first === null ? piece.to : Math.max(piece.from, first);
    if (first !== null) this.#giveUp({ id, from: claimTo, to: piece.to, why: 'recorded live' });
    if (claimTo <= piece.from) return null;
    return { claimTo, keepFrom: older && first !== null ? lo : -Infinity, keepTo: older && piece.after ? Math.min(claimTo, hi) : claimTo };
  }

  #giveUp(g: GivenUp): void { if (g.to > g.from) { this.#givenUp.push(g); this.#givenUpChanged = true; } }

  async #action(): Promise<void> {
    const started = this.#now(), planned = this.#plan(started), starting = started - this.#startedAt < START_MS;
    if (!starting) this.#maybeLogStart();
    if (!planned.length) {
      this.#save();
      this.#nextAt = started + (starting ? START_LOOK_MS : IDLE_MS);
      this.#maybeLog(started);
      return;
    }
    const byJob = new Map(planned.map(p => [p.job, p]));
    let trades = 0, recoveredMs = 0, filled = 0;
    const answered = new Set<string>();
    const fetcher: HistoryFetch = (request, signal) => this.#closed ? Promise.reject(new Error('closed')) : this.#fetch(request, AbortSignal.any([signal, this.#abort.signal]));
    const run = await runRecovery(planned.map(p => p.job), fetcher, { budget: this.#budget, now: this.#now, sleep: this.#sleep, onResult: raw => {
      if (this.#closed) return;
      const { names, claimTo, keepFrom, keepTo } = byJob.get(raw.job)!, job = raw.job;
      if (raw.pages > 0 && !raw.error) answered.add(job.source.bucket);
      // Rows in the server's names, only those it may keep, and no claim past where the live recording holds trades.
      const covered: [number, number] | null = raw.covered && Math.min(raw.covered[1], claimTo) > raw.covered[0] ? [raw.covered[0], Math.min(raw.covered[1], claimTo)] : null;
      const result: RecoveryResult = { ...raw, covered, rows: raw.rows.filter(r => r.t >= keepFrom && r.t < keepTo).map(r => ({ ...r, tradeId: names.fromVenue(r.tradeId) })) };
      trades += applyRecovered(this.#recordings, result);
      if (covered) { recoveredMs += covered[1] - covered[0]; filled++; return; }
      this.#tried(job, raw);
    } });
    if (this.#closed) return;
    // A limit that failed rests, longer each time it fails again; one that answered is rested no more.
    const now = this.#now();
    for (const bucket of answered) this.#rest.delete(bucket);
    for (const bucket of run.failed) { const ms = Math.min(LONGEST_REST_MS, (this.#rest.get(bucket)?.ms ?? FIRST_REST_MS / 2) * 2); this.#rest.set(bucket, { until: now + ms, ms }); this.#hour.failed.add(bucket); }
    // The part of a newest-page venue's gap its page did not reach never will: its page only moves on.
    for (const r of run.results) if (r.job.source.mode === 'latest' && r.pages > 0 && !r.error) this.#giveUp({ id: r.job.id, from: r.job.from, to: Math.min(r.covered?.[0] ?? r.job.to, byJob.get(r.job)!.claimTo), why: 'out of reach' });
    const t = this.#status.totals;
    t.actions++; t.pages += run.pages; t.rows += run.rows; t.trades += trades; t.recoveredMs += recoveredMs; t.failures += run.failed.length;
    this.#status.last = { at: started, ms: run.ms, gaps: run.results.length, pages: run.pages, rows: run.rows, trades, recoveredMs, stoppedBy: run.stoppedBy, failed: run.failed };
    this.#hour.gaps += filled; this.#hour.recoveredMs += recoveredMs; this.#hour.pages += run.pages; this.#hour.trades += trades;
    this.#save();
    this.#nextAt = now + (starting ? START_LOOK_MS : REST_MS);
    this.#maybeLog(now);
  }

  /** A gap answered for without any of it covered: counted, and given up after a few such tries (a venue failing is a rest, not a try). */
  #tried(job: RecoveryJob, result: RecoveryResult): void {
    if (result.error || result.pages === 0 || job.source.mode === 'latest') return;
    const key = `${job.id}|${job.from}|${job.to}`, tries = (this.#tries.get(key) ?? 0) + 1;
    if (tries < MAX_TRIES) { this.#tries.set(key, tries); return; }
    this.#tries.delete(key);
    this.#giveUp({ id: job.id, from: job.from, to: job.to, why: 'not in the history' });
  }

  #save(): void {
    const kept = this.#now() - this.#retentionMs;
    for (let i = this.#givenUp.length - 1; i >= 0; i--) if (this.#givenUp[i]!.to < kept) { this.#givenUp.splice(i, 1); this.#givenUpChanged = true; }
    if (!this.#file || !this.#givenUpChanged) return;
    try { fs.writeFileSync(this.#file, JSON.stringify({ givenUp: this.#givenUp })); this.#givenUpChanged = false; } catch { /* a read-only data directory: asked again after a restart */ }
  }

  /** Once, when the restart's gaps are done: what they were. */
  #maybeLogStart(): void {
    if (this.#startLogged) return;
    this.#startLogged = true;
    const t = this.#status.totals, b = this.#status.backlog;
    this.#log(`trade recovery: after the start, ${t.trades} trades recovered over ${(t.recoveredMs / SECOND).toFixed(0)} s from ${t.pages} pages; ${b.gaps} older gaps (${(b.ms / MINUTE).toFixed(1)} min) to work through`);
  }

  /** At most once an hour, and only when something happened. */
  #maybeLog(now: number): void {
    if (now - this.#lastLog < LOG_EVERY_MS) return;
    this.#lastLog = now;
    const h = this.#hour, b = this.#status.backlog;
    if (h.pages || h.failed.size) this.#log(`trade recovery: ${h.gaps} gaps filled (${(h.recoveredMs / MINUTE).toFixed(1)} min, ${h.trades} trades) from ${h.pages} pages in the last hour; ${b.gaps} gaps (${(b.ms / MINUTE).toFixed(1)} min) left${h.failed.size ? `; failed: ${[...h.failed].join(', ')}` : ''}`);
    this.#hour = { gaps: 0, recoveredMs: 0, pages: 0, trades: 0, failed: new Set() };
  }
}
