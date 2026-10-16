/**
 * The coverage record: for each instrument and metric, the stretches of time the recording was listening, so a minute recorded with
 * nothing in it is told apart from a minute nobody recorded (a page that was not open, a phone that suspended it, a feed reconnecting).
 *
 * Trades: a stretch is open while every connector that carries the instrument's trades is live and the engine's loop runs without a gap
 * (a frozen page runs no pass, so the time it was frozen is never covered). A feed that fails is covered only up to its last message. Each
 * stretch keeps the first and last trade it took (their venue ids and exchange times): the seam a recovery joins its rows to (see
 * `recovery.ts`), so nothing the recording holds is fetched and counted again. Stretches filled in from a venue's REST history are kept
 * apart as `recovered`.
 *
 * Depth: the depth recorder's own minute columns already say how many of a minute's twelve samples were taken (`Column.n`), so the depth
 * metric is read from them (`DepthRecorder.samples`) rather than kept twice.
 *
 * Times are the recorder's clock (ms). A stretch is written to the store cut at the minute still open: the recorders write a minute once it
 * has ended, so a stored stretch never claims a part of a minute whose trades were not stored with it (a page killed in the background).
 */

const MINUTE = 60_000;
export type CoverageMetric = 'trades' | 'depth';
export const COVERAGE_METRICS: readonly CoverageMetric[] = ['trades', 'depth'];
/** A pass this long after the one before means the loop did not run in between (a frozen or suspended page): the time between is not covered. */
export const MAX_PASS_GAP_MS = 2_500;
/** The longest window and the most instruments one coverage question may ask for (a day and its edges, the ALL VENUES lines and then some). */
export const MAX_COVERAGE_SPAN_MS = 26 * 3_600_000, MAX_COVERAGE_INSTRUMENTS = 48;

/** A trade a seam is drawn at: its venue id and exchange time. */
export interface SeamTrade { id: string; t: number }
export type SpanKind = 'live' | 'recovered';
/** A stretch [from, to) the trade recording covered, and the first and last trades it took (absent: none). */
export interface CoverSpan { from: number; to: number; kind: SpanKind; first?: SeamTrade; last?: SeamTrade }
/** A stretch as stored. */
export interface CoverageRow extends CoverSpan { inst: string; metric: CoverageMetric }
/** Where the stretches outlive the page or the process (IndexedDB in the browser, SQLite on the server). */
export interface CoverageStore { load(since: number): Iterable<CoverageRow>; save(rows: CoverageRow[], expireBefore: number): void; close(): void }

/** A stretch in memory: `prev` is the last trade of a minute before `last`'s, what the stored copy names when it is cut at the open minute. */
interface Held extends CoverSpan { prev?: SeamTrade }

/** A stretch the recording did not cover, with the trades that bound it: the last before (none: from a window's edge, by time) and the first after (none: up to now). */
export interface CoverGap { from: number; to: number; before: SeamTrade | null; after: SeamTrade | null }

/** Every trade stretch of every instrument, and the one open for each instrument whose feeds are live now. */
export class TradeCoverage {
  readonly #spans = new Map<string, Held[]>();
  readonly #open = new Map<string, { span: Held; at: number }>();
  readonly #dirty = new Set<Held>();
  readonly #store: CoverageStore | null;
  readonly #retentionMs: number;

  constructor(store: CoverageStore | null = null, protected now: () => number = Date.now, retentionMs = 24 * 3_600_000) {
    this.#store = store; this.#retentionMs = retentionMs;
    if (store) for (const row of store.load(now() - retentionMs)) {
      if (row.metric !== 'trades' || !(row.to > row.from)) continue;
      this.#list(row.inst).push({ from: row.from, to: row.to, kind: row.kind, ...(row.first ? { first: row.first } : {}), ...(row.last ? { last: row.last } : {}) });
    }
    for (const list of this.#spans.values()) list.sort((a, b) => a.from - b.from);
  }

  #list(id: string): Held[] { let list = this.#spans.get(id); if (!list) { list = []; this.#spans.set(id, list); } return list; }

  /**
   * One pass of the loop: whether every feed carrying `id`'s trades is live now. A live pass extends the open stretch to `now` when the pass
   * before was live and recent, and otherwise closes it as it was and opens another. A pass that is not live closes the open stretch, cut back
   * to `lastData` (the feed's last message: a socket that died quietly is only called failed once it has been silent for a while).
   */
  pass(id: string, live: boolean, now: number, lastData = now): void {
    const open = this.#open.get(id);
    if (live) {
      if (open && now - open.at <= MAX_PASS_GAP_MS && now >= open.span.to) { open.span.to = now; open.at = now; this.#dirty.add(open.span); return; }
      if (open) this.#close(id);
      const span: Held = { from: now, to: now, kind: 'live' };
      this.#list(id).push(span); this.#open.set(id, { span, at: now }); this.#dirty.add(span);
      return;
    }
    if (!open) return;
    open.span.to = Math.max(open.span.from, Math.min(open.span.to, lastData));
    this.#close(id);
  }

  /** Whether `id`'s trades are being recorded now (a stretch is open). */
  isOpen(id: string): boolean { return this.#open.has(id); }

  /** The recording of `id` ended at `now` on purpose (the venue was switched off): what it covered up to now stands. */
  end(id: string, now: number): void { const open = this.#open.get(id); if (!open) return; if (now >= open.span.to) open.span.to = now; this.#close(id); }

  #close(id: string): void {
    const open = this.#open.get(id); if (!open) return;
    this.#open.delete(id);
    if (open.span.to > open.span.from) return;
    // A stretch that covered nothing (opened and closed on one pass) goes; its trades are recorded and the seam before it still holds.
    const list = this.#list(id), at = list.indexOf(open.span); if (at >= 0) list.splice(at, 1);
    this.#dirty.delete(open.span);
  }

  /**
   * A trade the live recording took for `id` at `now`: the open stretch's first and last (none open: it is recorded, and named by no seam).
   * A trade that comes after the loop has missed its beat (a page back from being frozen hands on what its socket held before the first pass
   * runs) closes the stretch as it was: what arrives then is not known to be all there was, and the next live pass opens another.
   */
  trade(id: string, tradeId: string, t: number, now: number): void {
    const open = this.#open.get(id); if (!open) return;
    if (now - open.at > MAX_PASS_GAP_MS) { this.#close(id); return; }
    const span = open.span;
    span.first ??= { id: tradeId, t };
    if (span.last && Math.floor(t / MINUTE) > Math.floor(span.last.t / MINUTE)) span.prev = span.last;
    span.last = { id: tradeId, t };
  }

  /** Mark [from, to) of `id` as covered by trades recovered from the venue's history, with the oldest and newest of them. */
  recovered(id: string, from: number, to: number, first?: SeamTrade, last?: SeamTrade): void {
    if (!(to > from)) return;
    const span: Held = { from, to, kind: 'recovered', ...(first ? { first } : {}), ...(last ? { last } : {}) };
    const list = this.#list(id); list.push(span); list.sort((a, b) => a.from - b.from); this.#dirty.add(span);
  }

  /** The stretches of `id` that reach into [from, to), oldest first, as held (live and recovered; they may touch or overlap). */
  spans(id: string, from = -Infinity, to = Infinity): CoverSpan[] {
    return (this.#spans.get(id) ?? []).filter(s => s.to > from && s.from < to).map(s => ({ from: s.from, to: s.to, kind: s.kind, ...(s.first ? { first: s.first } : {}), ...(s.last ? { last: s.last } : {}) }));
  }

  /** The covered part of [from, to) for `id`: the stretches merged, cut to the window, oldest first (`kind` limits it to one kind). */
  covered(id: string, from: number, to: number, kind?: SpanKind): [number, number][] { return union((this.#spans.get(id) ?? []).filter(s => !kind || s.kind === kind), from, to); }

  /**
   * What [from, to) of `id` lacks, each stretch with the trades that bound it: the newest trade of the stretch that ends where it begins and
   * the oldest of the stretch that begins where it ends (by time, a stretch whose seam trade is outside the window does not count).
   */
  gaps(id: string, from: number, to: number): CoverGap[] {
    const list = this.#spans.get(id) ?? [], out: CoverGap[] = [];
    for (const [a, b] of complement(union(list, from, to), from, to)) {
      const before = list.filter(s => s.to === a && s.from < a && s.last).sort((x, y) => y.last!.t - x.last!.t)[0]?.last ?? null;
      const after = list.filter(s => s.from === b && s.to > b && s.first).sort((x, y) => x.first!.t - y.first!.t)[0]?.first ?? null;
      out.push({ from: a, to: b, before: a > from || (before && before.t >= from) ? before : null, after: b < to ? after : null });
    }
    return out;
  }

  /**
   * Write what changed and let go of what the retention has passed. Unless `final` (the page or the process is going away, and the recorders
   * write the minute still open too), each stretch is written cut at the minute still open, naming the last trade before it, and stays to
   * be written again whole once that minute has ended.
   */
  flush(final = false): void {
    const now = this.now(), cutoff = now - this.#retentionMs, open = Math.floor(now / MINUTE) * MINUTE;
    for (const [id, list] of this.#spans) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.to < cutoff && this.#open.get(id)?.span !== list[i]) { this.#dirty.delete(list[i]!); list.splice(i, 1); }
      if (!list.length) this.#spans.delete(id);
    }
    if (!this.#store) { this.#dirty.clear(); return; }
    const rows: CoverageRow[] = [];
    for (const [id, list] of this.#spans) for (const span of list) {
      if (!this.#dirty.has(span)) continue;
      const whole = final || span.to <= open, to = whole ? span.to : Math.min(span.to, open);
      if (whole && this.#open.get(id)?.span !== span) this.#dirty.delete(span);
      if (!(to > span.from)) continue;
      const last = whole ? span.last : span.last && span.last.t < open ? span.last : span.prev && span.prev.t < open ? span.prev : undefined;
      rows.push({ inst: id, metric: 'trades', from: span.from, to, kind: span.kind, ...(span.first && span.first.t < to ? { first: span.first } : {}), ...(last ? { last } : {}) });
    }
    if (rows.length) this.#store.save(rows, cutoff);
  }
  close(): void { this.flush(true); this.#store?.close(); }
}

/** The stretches merged and cut to [from, to), oldest first. */
export function union(spans: Iterable<{ from: number; to: number }>, from: number, to: number): [number, number][] {
  const cut = [...spans].map(s => [Math.max(from, s.from), Math.min(to, s.to)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of cut) { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
/** The parts of [from, to) that merged, ordered stretches leave out. */
export function complement(merged: readonly (readonly [number, number])[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of merged) { if (a > at) out.push([at, Math.min(a, to)]); at = Math.max(at, b); }
  if (at < to) out.push([at, to]);
  return out.filter(([a, b]) => b > a);
}
/** How many ms of [from, to) merged, ordered stretches cover. */
export function coveredMs(merged: readonly (readonly [number, number])[], from: number, to: number): number {
  let ms = 0; for (const [a, b] of merged) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return ms;
}
/** Whether merged stretches cover all of [from, to). */
export const coversAll = (merged: readonly (readonly [number, number])[], from: number, to: number): boolean => !(to > from) || coveredMs(merged, from, to) >= to - from;

// ---- The answer ---------------------------------------------------------------------------------------------------------------------

/**
 * One instrument's coverage over a window of whole minutes: the covered stretches (merged), the part of them recovered from the venue's
 * history (trades), and per minute the seconds covered and whether the recording holds anything for it (trades: footprint rows; depth: a
 * column with levels). For depth a minute's seconds are its samples times five and `spans` are its fully sampled minutes.
 */
export interface CoverageInstrument { id: string; spans: [number, number][]; recovered: [number, number][]; seconds: number[]; held: boolean[] }
/** `asOf`: the source's clock when it answered (the open minute is covered up to about then at most). */
export interface CoverageAnswer { metric: CoverageMetric; from: number; to: number; asOf: number; instruments: CoverageInstrument[] }

/** What a minute is: nobody recorded it, recorded in part, recorded with nothing in it, recorded with something, or held but with no record of being covered (recorded before the record was kept). */
export type MinuteState = 'missing' | 'partial' | 'empty' | 'recorded' | 'unknown';
export function minuteState(seconds: number, held: boolean): MinuteState {
  if (seconds >= 60) return held ? 'recorded' : 'empty';
  if (seconds <= 0) return held ? 'unknown' : 'missing';
  return 'partial';
}

/** The whole minutes a question about [from, to) is answered for. */
export const coverageWindow = (from: number, to: number): { from: number; to: number } => ({ from: Math.floor(from / MINUTE) * MINUTE, to: Math.ceil(to / MINUTE) * MINUTE });

/** A trade instrument's answer from its stretches and the minutes the recording holds. */
export function tradeAnswer(id: string, coverage: TradeCoverage, from: number, to: number, held: (minute: number) => boolean): CoverageInstrument {
  const spans = coverage.covered(id, from, to), seconds: number[] = [], has: boolean[] = [];
  for (let t = from; t < to; t += MINUTE) { seconds.push(Math.floor(coveredMs(spans, t, t + MINUTE) / 1000)); has.push(held(t)); }
  return { id, spans, recovered: coverage.covered(id, from, to, 'recovered'), seconds, held: has };
}
/** A depth instrument's answer from its columns' sample counts (`n` of twelve) and whether each holds levels. */
export function depthAnswer(id: string, columns: ReadonlyMap<number, { n: number; levels: boolean }>, from: number, to: number): CoverageInstrument {
  const seconds: number[] = [], held: boolean[] = [], full: [number, number][] = [];
  for (let t = from; t < to; t += MINUTE) {
    const c = columns.get(t), s = c ? Math.min(60, c.n * 5) : 0;
    seconds.push(s); held.push(c?.levels === true);
    if (s >= 60) full.push([t, t + MINUTE]);
  }
  return { id, spans: union(full.map(([a, b]) => ({ from: a, to: b })), from, to), recovered: [], seconds, held };
}

/**
 * A coverage answer checked field by field against the question (the instruments asked for, the minutes of the window): the answer, or null
 * when it is anything else. An instrument the source does not know may be left out.
 */
export function parseCoverage(value: unknown, ids: readonly string[], metric: CoverageMetric, from: number, to: number): CoverageAnswer | null {
  const body = value as Partial<Record<keyof CoverageAnswer, unknown>> | null, w = coverageWindow(from, to), minutes = Math.round((w.to - w.from) / MINUTE);
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const stretches = (v: unknown): v is [number, number][] => Array.isArray(v) && v.every(s => Array.isArray(s) && s.length === 2 && num(s[0]) && num(s[1]) && s[1] > s[0] && s[0] >= w.from && s[1] <= w.to);
  if (!body || body.metric !== metric || body.from !== w.from || body.to !== w.to || !num(body.asOf) || !Array.isArray(body.instruments)) return null;
  const asked = new Set(ids), out: CoverageInstrument[] = [];
  for (const item of body.instruments as unknown[]) {
    const i = item as Partial<Record<keyof CoverageInstrument, unknown>> | null;
    if (!i || typeof i.id !== 'string' || !asked.has(i.id) || !stretches(i.spans) || !stretches(i.recovered) || !Array.isArray(i.seconds) || i.seconds.length !== minutes
      || !i.seconds.every(s => num(s) && Number.isInteger(s) && s >= 0 && s <= 60) || !Array.isArray(i.held) || i.held.length !== minutes || !i.held.every(h => typeof h === 'boolean')) return null;
    out.push({ id: i.id, spans: i.spans.map(([a, b]) => [a, b]), recovered: i.recovered.map(([a, b]) => [a, b]), seconds: [...i.seconds as number[]], held: [...i.held as boolean[]] });
  }
  return { metric, from: w.from, to: w.to, asOf: body.asOf, instruments: out };
}
