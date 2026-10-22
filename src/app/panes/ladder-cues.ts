import { PULSE_LIFE_MS, pulseEnvelope } from '../candle/model.ts';

/**
 * The ladder's cues, as data: which of the observed changes get light, how long, and where the book's cells are (all pure and tested; the
 * pane paints them, `ladder-cue-paint.ts`).
 *
 * What a cue says. A venue's cell lights when the depth that venue shows at that price changed between two of its own observations (the
 * tracker, `book-cues.ts`, finds those and rejects the rest): the same signed size and the same envelope for an addition and a decrease
 * (Karl: "dim by the same proportions for the same amount of time"), an addition outward through the cell and a decrease back inward.
 * It is a statement about the displayed depth, never about orders: no order is known to have been added, cancelled or traded.
 *
 * Why a budget. Per-venue changes with the Tape's own gate come about 20 a second, 25 cells lit at once and 88 in the worst second of
 * 340 (live study, 2026-10-22), and the page flashes more than three times a second over any area. Light is therefore spent from a budget:
 * at most `maxRecords` cells lit at once and a lit area under `maxArea`, the largest changes first and every venue's largest before any
 * venue's second, and nothing bypasses it, however large the change. A change that gets no light is not lost: its row keeps a signed mark
 * for a few seconds (`marks`), the hover names it, and the book itself already moved.
 */

/** A cue's life: the Tape's envelope (80 ms up, 450 ms release, 1.5 s at most). */
export const CUE_LIFE_MS = PULSE_LIFE_MS;
/** How long a row's signed mark stays (it fades over this). */
export const MARK_LIFE_MS = 3_500;
/** How long a cue's crest takes to cross its cell. */
export const CREST_MS = 380;
/** Cues lit at once, and the area they may cover (CSS px squared): under a quarter of W3C's 10-degree flash area (about 21,800 px2) with the Tape and the page's waves besides. */
export const MAX_CUES = 40;
export const MAX_CUE_AREA = 12_000;
/** A change lights nothing under this strength (1 - exp(-|usd| / scale)): the mark and the hover still name it. */
export const MIN_CUE_STRENGTH = 0.04;

/** How a cue looks. `marks` lights nothing: only the rows' signed marks show (reduced motion, and a look of its own). */
export type CueLook = 'wash' | 'rim' | 'deposit' | 'marks';
/** What a look costs against the area budget, per px2 of the cell it lights: a rim is a thin line, a wash the whole cell. */
export const LOOK_COST: Readonly<Record<CueLook, number>> = { wash: 1, deposit: 0.6, rim: 0.2, marks: 0 };

/** One row's change of one venue's displayed depth, as the tracker's `rowEvents` gives it. */
export interface CueRow { id: string; side: 'bid' | 'ask'; row: number; usd: number; strength: number; wall: number; seq: number; removed: boolean; added: boolean; pair: boolean; band: boolean }

/** A cell as the last draw laid it out (CSS px), with the USD it shows. */
export interface Cell { x: number; y: number; w: number; h: number; usd: number }
/** Where the cells are: what `CellMap` answers. */
export interface Geometry { cell(id: string, side: 'bid' | 'ask', row: number): Cell | null; rowVisible(row: number): boolean }

export interface Cue {
  /** `${id}|${side}|${row}`: one cue a cell. */
  key: string; id: string; side: 'bid' | 'ask'; row: number;
  sign: 1 | -1; strength: number; usd: number;
  /** The presentation clock (performance.now) when it began. */
  t0: number;
  removed: boolean; added: boolean; pair: boolean; band: boolean;
  /** What it costs against the area budget (px2). */
  cost: number;
  seq: number;
}
/** A row's signed mark: the strongest recent change on the row, lit or not. */
export interface Mark { id: string; side: 'bid' | 'ask'; row: number; sign: 1 | -1; strength: number; usd: number; t0: number; lit: boolean; removed: boolean; pair: boolean }

export const cueKey = (id: string, side: 'bid' | 'ask', row: number): string => `${id}|${side}|${row}`;
export const markKey = (side: 'bid' | 'ask', row: number): string => `${side}|${row}`;

/** Where a cue's crest is along its cell, 0 (the cell's inner edge) to 1 (its outer): out for an addition, back in for a decrease. */
export function crestAt(sign: 1 | -1, age: number): number {
  const p = Math.min(1, Math.max(0, age / CREST_MS));
  return sign > 0 ? p : 1 - p;
}
/** How bright the crest is at `age` (0 to 1): as strong as the change, gone within about half a second. */
export const crestLight = (strength: number, age: number): number => age < 0 || age > CUE_LIFE_MS ? 0 : strength * Math.exp(-age / 520);
/** The body's change at `age` (0 to 1): the same envelope for both signs. */
export const bodyLight = (strength: number, age: number): number => strength * pulseEnvelope(age);
/** A mark's opacity at `age`: full for a moment, then fading out linearly. */
export const markLight = (age: number): number => age < 0 || age > MARK_LIFE_MS ? 0 : Math.min(1, 1.6 * (1 - age / MARK_LIFE_MS));

/**
 * The cues lit now, the rows' marks, and the changes waiting for the next draw (the draw knows where the cells are, so it decides who gets
 * light). One board for one pane.
 */
export class CueBoard {
  readonly active: Cue[] = [];
  readonly marks = new Map<string, Mark>();
  #pending: CueRow[] = [];
  /** What the budget turned down since the start (for tests and the console). */
  readonly stats = { pushed: 0, lit: 0, renewed: 0, reversed: 0, turnedDown: 0, off: 0 };
  constructor(private readonly caps: { maxCues: number; maxArea: number } = { maxCues: MAX_CUES, maxArea: MAX_CUE_AREA }) {}

  /** Changes seen at a data frame; they wait for `admit`. Bounded: a stall cannot pile them up. */
  push(rows: readonly CueRow[]): void {
    for (const r of rows) { if (this.#pending.length >= 512) this.#pending.shift(); this.#pending.push(r); }
    this.stats.pushed += rows.length;
  }
  get waiting(): number { return this.#pending.length; }

  /** Nothing is lit and nothing waits: a hidden pane, a replay, a new coin. */
  clear(): void { this.active.length = 0; this.marks.clear(); this.#pending.length = 0; }

  /** Drop what is over by `now`. Returns whether any cue is still lit. */
  prune(now: number): boolean {
    let w = 0;
    for (const c of this.active) if (now - c.t0 <= CUE_LIFE_MS) this.active[w++] = c;
    this.active.length = w;
    for (const [k, m] of this.marks) if (now - m.t0 > MARK_LIFE_MS) this.marks.delete(k);
    return w > 0;
  }

  /** The area the lit cues have cost. */
  get used(): number { let a = 0; for (const c of this.active) a += c.cost; return a; }

  /**
   * Give the waiting changes light, largest first (the first of every venue before the second of any), within the caps: nothing bypasses them.
   * A change whose cell is not on screen lights nothing; a change on a visible row always leaves its mark. `look` prices the area (`LOOK_COST`).
   */
  admit(now: number, look: CueLook, geo: Geometry): void {
    const pending = this.#pending; this.#pending = [];
    if (!pending.length) return;
    this.prune(now);
    const lit = look !== 'marks', weight = LOOK_COST[look];
    // The venue's rank among its own changes, so one busy venue cannot take every place before a quiet one gets its first.
    const byVenue = new Map<string, CueRow[]>();
    for (const r of pending) { let list = byVenue.get(r.id); if (!list) { list = []; byVenue.set(r.id, list); } list.push(r); }
    const order: { r: CueRow; rank: number }[] = [];
    for (const list of byVenue.values()) { list.sort((a, b) => b.strength - a.strength || a.seq - b.seq || a.row - b.row); list.forEach((r, rank) => order.push({ r, rank })); }
    order.sort((a, b) => a.rank - b.rank || b.r.strength - a.r.strength || a.r.seq - b.r.seq || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
    let used = this.used;
    for (const { r } of order) {
      if (!geo.rowVisible(r.row) || !(r.usd !== 0) || !Number.isFinite(r.usd)) continue;
      const sign: 1 | -1 = r.usd > 0 ? 1 : -1, cell = geo.cell(r.id, r.side, r.row), key = cueKey(r.id, r.side, r.row);
      const old = this.active.findIndex(c => c.key === key);
      let didLight = false;
      if (lit && cell && r.strength >= MIN_CUE_STRENGTH) {
        const cost = Math.max(1, cell.w) * Math.max(1, cell.h) * (0.25 + 0.75 * r.strength) * weight;
        const freed = old >= 0 ? this.active[old]!.cost : 0;
        if (this.active.length - (old >= 0 ? 1 : 0) < this.caps.maxCues && used - freed + cost <= this.caps.maxArea) {
          const cue: Cue = { key, id: r.id, side: r.side, row: r.row, sign, strength: r.strength, usd: r.usd, t0: now, removed: r.removed, added: r.added, pair: r.pair, band: r.band, cost, seq: r.seq };
          if (old >= 0) {
            const was = this.active[old]!;
            if (was.sign === sign) { cue.strength = Math.max(was.strength, r.strength); cue.usd = was.usd + r.usd; this.stats.renewed++; } else this.stats.reversed++;
            this.active[old] = cue; used += cost - freed;
          } else { this.active.push(cue); used += cost; }
          didLight = true; this.stats.lit++;
        } else this.stats.turnedDown++;
      } else if (!lit) this.stats.off++;
      const mk = markKey(r.side, r.row), had = this.marks.get(mk);
      if (!had || r.strength >= had.strength * markLight(now - had.t0) || had.sign !== sign && r.strength >= 0.5 * had.strength) {
        this.marks.set(mk, { id: r.id, side: r.side, row: r.row, sign, strength: r.strength, usd: r.usd, t0: now, lit: didLight, removed: r.removed, pair: r.pair });
      }
    }
  }
}

/**
 * Where the cells of the last draw are, kept in arrays that are reused from one draw to the next (a draw lays out every venue's cell of every
 * row; a map of strings per cell would make thousands of them a second). A row is its absolute row index at the book's step; `top` is the
 * row index of the first row on screen.
 */
export class CellMap implements Geometry {
  #top = 0; #rows = 0;
  #by = new Map<string, { x: Float32Array; y: Float32Array; w: Float32Array; h: Float32Array; usd: Float32Array; side: Uint8Array }>();
  /** Start a draw: `rows` rows from row index `top` down. */
  begin(top: number, rows: number): void {
    this.#top = top; this.#rows = rows;
    for (const e of this.#by.values()) { if (e.w.length < rows) { e.x = new Float32Array(rows); e.y = new Float32Array(rows); e.w = new Float32Array(rows); e.h = new Float32Array(rows); e.usd = new Float32Array(rows); e.side = new Uint8Array(rows); } else { e.w.fill(0, 0, rows); } }
  }
  /** A cell: venue `id`, on screen row number `r` (0 at the top), showing `side` ('bid' = 0, 'ask' = 1). */
  set(id: string, r: number, side: 0 | 1, x: number, y: number, w: number, h: number, usd: number): void {
    if (r < 0 || r >= this.#rows) return;
    let e = this.#by.get(id);
    if (!e) { e = { x: new Float32Array(this.#rows), y: new Float32Array(this.#rows), w: new Float32Array(this.#rows), h: new Float32Array(this.#rows), usd: new Float32Array(this.#rows), side: new Uint8Array(this.#rows) }; this.#by.set(id, e); }
    e.x[r] = x; e.y[r] = y; e.w[r] = w; e.h[r] = h; e.usd[r] = usd; e.side[r] = side;
  }
  rowVisible(row: number): boolean { const r = this.#top - row; return r >= 0 && r < this.#rows; }
  cell(id: string, side: 'bid' | 'ask', row: number): Cell | null {
    const r = this.#top - row;
    if (r < 0 || r >= this.#rows) return null;
    const e = this.#by.get(id);
    if (!e || !(e.w[r]! > 0) || e.side[r] !== (side === 'ask' ? 1 : 0)) return null;
    return { x: e.x[r]!, y: e.y[r]!, w: e.w[r]!, h: e.h[r]!, usd: e.usd[r]! };
  }
  /** The row index of screen row `r`. */
  rowOf(r: number): number { return this.#top - r; }
  get top(): number { return this.#top; }
  get rows(): number { return this.#rows; }
  /** Venues dropped from the book are forgotten with the rest of a draw's state. */
  forget(keep: ReadonlySet<string>): void { for (const id of this.#by.keys()) if (!keep.has(id)) this.#by.delete(id); }
}
