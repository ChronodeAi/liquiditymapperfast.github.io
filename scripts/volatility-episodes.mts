/**
 * The volatility casebook (docs/volatility-watch.md): every recorded minute, kept past the recordings' week, and every volatile move up or down
 * with what the markets and the models showed before, during and after it.
 *
 *   npm run volatility:episodes -- [--data data/runtime] [--out Research_Results/volatility-episodes] [--ref binance:BTCUSDT] [--coin BTC]
 *
 * First each whole UTC day not kept yet is written to `<out>/minutes/<day>.jsonl.gz`, one `Minute` a line. The recordings it reads keep a
 * week (RETENTION_MS in shared/recorder.ts), so it has to run at least every six days. Then the casebook is rebuilt from every kept day and
 * today's recordings: `episodes.jsonl` (the moves), `alarms.jsonl` (each model's loud readings and what followed them), `cases/<move>.txt`
 * (each move minute by minute) and `summary.txt`, whose tables of what tells a move is coming and which way use every minute. Times are UTC.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { auc, label, readLog, type Row } from './volatility-eval.mts';
import { confluence } from '../src/shared/volatility/confluence.ts';
import { SUBQ_ARMS } from '../src/shared/volatility/jev.ts';
import { BROWSER_VENUES } from '../src/shared/venues.ts';
import { columnOf } from '../src/server/v2/store.mts';
import { toRow } from '../src/server/v2/flow.mts';
import { autoThreshold, markedPart, parseGroup, type AbsorptionGroup } from '../src/shared/absorption.ts';
import { ABSORPTION_DEFAULTS } from '../src/app/absorption.ts';

const MINUTE = 60_000, DAY = 86_400_000;
/** Each book's resting USD is kept in these bands from its middle (bp, upper edges). */
const BANDS_BP = [10, 25, 50, 100, 200];
/** All books on one fixed price grid: its cell ($) and its reach either side of the close (a fraction). */
const CELL_USD = 50, GRID_REACH = 0.02;
/** A minute is volatile when price moves K sigma of 15-minute returns within HORIZON minutes; a move is strong with a minute at STRONG_K. */
const K = 2, STRONG_K = 3, HORIZON = 15;
/** Volatile minutes of one direction at most GAP minutes apart are one move; its swing is sought from LEAD minutes before them to TRAIL after. */
const GAP = 15, LEAD = 10, TRAIL = 20;
/** A model's reading is loud from this score of 4 (the Sounds panel's default); the confluence's is loud when it makes a call. */
const LOUD = 3;
const MODELS = ['jev', ...SUBQ_ARMS, 'confluence'] as const;
type Model = typeof MODELS[number];
const NAMES: Record<Model, string> = { jev: 'Jev', subq: 'SubQ', subqHistory: 'SubQ+history', subqImage: 'SubQ+image', confluence: 'Confluence' };

/** One kept minute: `t` is its start (ms, UTC); USD throughout. */
export interface Minute {
  t: number;
  /** The reference perpetual's candle. */
  candle?: { o: number; h: number; l: number; c: number; v: number };
  /** Per market of the coin: taker buy USD, taker sell USD and the minute's last traded price (0: no trade). */
  flow: Record<string, [number, number, number]>;
  /** Forced orders: time (ms), market, the side liquidated, USD, price and the venue's kind of report. */
  liq: [number, string, 'long' | 'short', number, number, string][];
  /** Per book: resting bids then asks (the minute's mean) in the BANDS_BP bands from the book's own middle. */
  depth: Record<string, number[]>;
  /** All perpetual and all spot books on the fixed grid over the close ± GRID_REACH, cell 0 starting at `from` ($). */
  grid?: { from: number; perpBid: number[]; perpAsk: number[]; spotBid: number[]; spotAsk: number[] };
  /** Per perpetual: open interest at the minute's end in coins, and in USD where the venue says. */
  oi: Record<string, [number, number | null]>;
  /**
   * Per market: absorption as the page marks it by default (`absorptionOf`): buy-aggressor groups and their marked USD, then sell-aggressor
   * groups and theirs. Every market whose minute of window sums was recorded; the days kept before this field (up to 2026-10-19) have none.
   */
  absorption?: Record<string, [number, number, number, number]>;
  /** The volatility reading made as this minute closed (its `features.t` is `t` + 1 minute): the `volatility-log.jsonl` row as logged. */
  reading?: Row;
}

const KINDS = new Map(BROWSER_VENUES.map(v => [v.id, v.kind]));
/** 'perp' or 'spot' for a market id (venue:symbol) of `coin`; anything else is null. */
function kindOf(inst: string, coin: string): 'perp' | 'spot' | null {
  const colon = inst.indexOf(':');
  return colon > 0 && inst.startsWith(coin, colon + 1) ? KINDS.get(inst.slice(0, colon)) ?? null : null;
}

/**
 * One market's absorption in minute `t` as the page marks it by default (`ABSORPTION_DEFAULTS`, `thresholds` in app/absorption.ts): the
 * threshold is mean + k standard deviations of the window sums in the market's minutes of the last `sdMinutes` up to and including `t` (the
 * page's complete minutes just after `t` closed), and each group starting in `t` whose largest credit reaches it adds its marked part.
 * [buy groups, buy USD, sell groups, sell USD] by aggressor side; null when those minutes hold no window sums (nothing can be marked).
 */
export function absorptionOf(groups: readonly AbsorptionGroup[], minutes: readonly { t: number; n: number; mean: number; m2: number }[], t: number): [number, number, number, number] | null {
  const { k, sdMinutes } = ABSORPTION_DEFAULTS;
  const threshold = autoThreshold(minutes.filter(m => m.t > t - sdMinutes * MINUTE && m.t <= t), k);
  if (threshold === null) return null;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (const g of groups) {
    const part = markedPart(g, threshold);
    if (!part) continue;
    const at = g.side === 'buy' ? 0 : 2;
    out[at]++; out[at + 1] += part.usd;
  }
  return [out[0], Math.round(out[1]), out[2], Math.round(out[3])];
}

interface Sources { history: DatabaseSync; depth: DatabaseSync; log: Map<number, Row>; ref: string; coin: string }

/** Every minute of [from, to) the recordings hold anything for, oldest first. */
function readMinutes(src: Sources, from: number, to: number): Minute[] {
  const at = new Map<number, Minute>();
  const minute = (t: number): Minute => { let m = at.get(t); if (!m) at.set(t, m = { t, flow: {}, liq: [], depth: {}, oi: {} }); return m; };
  const candles = src.history.prepare("SELECT start_timestamp AS t, open AS o, high AS h, low AS l, close AS c, volume AS v FROM candle_samples WHERE instrument_id = ? AND interval = '1m' AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp");
  for (const r of candles.all(src.ref, from, to) as { t: number; o: number; h: number; l: number; c: number; v: number }[]) minute(r.t).candle = { o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
  for (const r of src.depth.prepare('SELECT inst, t, data FROM flow_minutes WHERE t >= ? AND t < ?').all(from, to) as { inst: string; t: number; data: Uint8Array }[]) {
    const row = kindOf(r.inst, src.coin) ? toRow(r) : null;
    if (!row) continue;
    let buy = 0, sell = 0, last = 0;
    for (let s = 0; s < 60; s++) { buy += row.buy[s]!; sell += row.sell[s]!; if (row.px && row.px[s]! > 0) last = row.px[s]!; }
    minute(r.t).flow[r.inst] = [Math.round(buy), Math.round(sell), Math.round(last * 100) / 100];
  }
  for (const r of src.depth.prepare('SELECT t, inst, side, price, usd, kind FROM liquidations WHERE t >= ? AND t < ? ORDER BY t').all(from, to) as { t: number; inst: string; side: 'long' | 'short'; price: number; usd: number; kind: string }[]) {
    if (kindOf(r.inst, src.coin)) minute(Math.floor(r.t / MINUTE) * MINUTE).liq.push([r.t, r.inst, r.side, Math.round(r.usd), r.price, r.kind]);
  }
  for (const r of src.history.prepare('SELECT instrument_id AS inst, bucket_start AS t, close_base AS base, close_quote AS quote FROM oi_bars WHERE interval_ms = 60000 AND bucket_start >= ? AND bucket_start < ?').all(from, to) as { inst: string; t: number; base: number; quote: number | null }[]) {
    if (kindOf(r.inst, src.coin) === 'perp') minute(r.t).oi[r.inst] = [r.base, r.quote === null ? null : Math.round(r.quote)];
  }
  const grids = new Map<number, NonNullable<Minute['grid']>>();
  const columns = src.depth.prepare('SELECT inst, t, n, step, data FROM depth_columns WHERE t >= ? AND t < ?');
  for (const r of columns.all(from, to) as { inst: string; t: number; n: number; step: number; data: Uint8Array }[]) {
    const kind = kindOf(r.inst, src.coin), column = kind ? columnOf(r.t, r.n, r.data, null) : null;
    if (!column) continue;
    const m = minute(r.t);
    let bestBid = -Infinity, bestAsk = Infinity;
    for (let i = 0; i < column.bins.length; i++) { const bin = column.bins[i]!; if (column.bid[i]! > 0 && bin > bestBid) bestBid = bin; if (column.ask[i]! > 0 && bin < bestAsk) bestAsk = bin; }
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) continue;
    const middle = (bestBid + bestAsk + 1) / 2 * r.step, bands = new Array<number>(BANDS_BP.length * 2).fill(0);
    const close = m.candle?.c, lo = close ? Math.floor(close * (1 - GRID_REACH) / CELL_USD) : 0, cells = close ? Math.floor(close * (1 + GRID_REACH) / CELL_USD) - lo + 1 : 0;
    let grid = grids.get(r.t);
    if (!grid && close) grids.set(r.t, grid = { from: lo * CELL_USD, perpBid: new Array<number>(cells).fill(0), perpAsk: new Array<number>(cells).fill(0), spotBid: new Array<number>(cells).fill(0), spotAsk: new Array<number>(cells).fill(0) });
    for (let i = 0; i < column.bins.length; i++) {
      const price = (column.bins[i]! + 0.5) * r.step, bp = (price - middle) / middle * 1e4, bid = column.bid[i]!, ask = column.ask[i]!;
      if (bid > 0) { const b = BANDS_BP.findIndex(x => Math.max(0, -bp) < x); if (b >= 0) bands[b] += bid; }
      if (ask > 0) { const b = BANDS_BP.findIndex(x => Math.max(0, bp) < x); if (b >= 0) bands[BANDS_BP.length + b] += ask; }
      const cell = grid ? Math.floor(price / CELL_USD) - lo : -1;
      if (!grid || cell < 0 || cell >= cells) continue;
      if (kind === 'perp') { grid.perpBid[cell] += bid; grid.perpAsk[cell] += ask; } else { grid.spotBid[cell] += bid; grid.spotAsk[cell] += ask; }
    }
    m.depth[r.inst] = bands.map(Math.round);
  }
  for (const [t, g] of grids) minute(t).grid = { from: g.from, perpBid: g.perpBid.map(Math.round), perpAsk: g.perpAsk.map(Math.round), spotBid: g.spotBid.map(Math.round), spotAsk: g.spotAsk.map(Math.round) };
  // Absorption: each market's minutes of window sums (from `sdMinutes` before `from`, so the first minutes have their threshold) and its
  // groups by the minute of their first fill.
  const reach = ABSORPTION_DEFAULTS.sdMinutes * MINUTE, sums = new Map<string, { t: number; n: number; mean: number; m2: number }[]>();
  for (const r of src.depth.prepare('SELECT inst, t, n, mean, m2 FROM absorption_minutes WHERE t >= ? AND t < ? ORDER BY t').all(from - reach, to) as { inst: string; t: number; n: number; mean: number; m2: number }[]) {
    if (!kindOf(r.inst, src.coin)) continue;
    let list = sums.get(r.inst);
    if (!list) sums.set(r.inst, list = []);
    list.push(r);
  }
  const groupsAt = new Map<string, AbsorptionGroup[]>();
  for (const r of src.depth.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE t0 >= ? AND t0 < ?').all(from, to) as { inst: string; t0: number; side: string; price: number; steps: string }[]) {
    if (!kindOf(r.inst, src.coin)) continue;
    let steps: unknown;
    try { steps = JSON.parse(r.steps); } catch { continue; }
    const g = parseGroup({ id: r.inst, side: r.side, price: r.price, t0: r.t0, steps });
    if (!g) continue;
    const key = `${r.inst} ${Math.floor(r.t0 / MINUTE) * MINUTE}`;
    let list = groupsAt.get(key);
    if (!list) groupsAt.set(key, list = []);
    list.push(g);
  }
  for (const [inst, list] of sums) {
    let first = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!.t;
      if (t < from) continue;
      while (list[first]!.t <= t - reach) first++;
      const a = absorptionOf(groupsAt.get(`${inst} ${t}`) ?? [], list.slice(first, i + 1), t);
      if (a) (minute(t).absorption ??= {})[inst] = a;
    }
  }
  for (const m of at.values()) { const row = src.log.get(m.t + MINUTE); if (row) m.reading = row; }
  return [...at.values()].sort((a, b) => a.t - b.t);
}

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Writes each whole day the recordings hold and `dir` does not; returns the end of the last day kept (or the first recording when none). */
function keepDays(src: Sources, dir: string, now: number): number {
  fs.mkdirSync(dir, { recursive: true });
  const firsts = [
    src.history.prepare("SELECT MIN(start_timestamp) AS t FROM candle_samples WHERE instrument_id = ? AND interval = '1m'").get(src.ref) as { t: number | null },
    src.depth.prepare('SELECT MIN(t) AS t FROM flow_minutes').get() as { t: number | null },
  ].map(r => r.t).filter((t): t is number => t !== null);
  if (!firsts.length) return now;
  const first = Math.min(...firsts);
  let kept = first;
  // A day is whole once its last minute's reading is logged and its flow stored: ten minutes after midnight.
  for (let day = Math.floor(first / DAY) * DAY; day + DAY + 10 * MINUTE <= now; day += DAY) {
    const file = path.join(dir, `${dayOf(day)}.jsonl.gz`);
    if (!fs.existsSync(file)) {
      const minutes = readMinutes(src, day, day + DAY);
      if (minutes.length) {
        fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(minutes.map(m => JSON.stringify(m)).join('\n') + '\n'));
        fs.renameSync(`${file}.tmp`, file);
        console.log(`kept ${dayOf(day)}: ${minutes.length} minutes`);
      }
    }
    kept = day + DAY;
  }
  return kept;
}

const FIELDS = ['o', 'h', 'l', 'c', 'perpNet', 'spotNet', 'perpGross', 'spotGross', 'refNet', 'refSpotNet', 'liqLong', 'liqShort', 'liqMax',
  'liqMaxPrice', 'bid50', 'ask50', 'bidAdd', 'bidPull', 'askAdd', 'askPull', 'topBid', 'topBidUsd', 'topAsk', 'topAskUsd', 'oi', 'premium',
  'basis', 'cascade'] as const;
type Field = typeof FIELDS[number];
const SUMMED = ['perpNet', 'spotNet', 'perpGross', 'spotGross', 'refNet', 'refSpotNet', 'liqLong', 'liqShort', 'bidAdd', 'bidPull', 'askAdd', 'askPull'] as const;
type Summed = typeof SUMMED[number];
interface Calls { score: number[]; dir: number[]; p: number[]; loud: number[] }

/** The kept minutes as columns, an index a minute from `t0`; NaN where a minute has nothing. */
class Series {
  t0 = NaN;
  readonly v = Object.fromEntries(FIELDS.map(k => [k, [] as number[]])) as Record<Field, number[]>;
  readonly calls = Object.fromEntries(MODELS.map(m => [m, { score: [] as number[], dir: [] as number[], p: [] as number[], loud: [] as number[] }])) as Record<Model, Calls>;
  #last: { i: number; grid: NonNullable<Minute['grid']>; l: number; h: number } | null = null;
  constructor(readonly ref: string) {}
  get length(): number { return this.v.c.length; }
  time(i: number): number { return this.t0 + i * MINUTE; }

  add(m: Minute): void {
    if (!Number.isFinite(this.t0)) this.t0 = m.t;
    const i = Math.round((m.t - this.t0) / MINUTE);
    if (i < this.length) return; // a minute read already
    while (this.length <= i) {
      for (const k of FIELDS) this.v[k].push(NaN);
      for (const model of MODELS) for (const a of Object.values(this.calls[model])) a.push(NaN);
    }
    const v = this.v, c = m.candle;
    if (c) { v.o[i] = c.o; v.h[i] = c.h; v.l[i] = c.l; v.c[i] = c.c; }
    const flows = Object.entries(m.flow);
    if (flows.length) {
      let perpNet = 0, spotNet = 0, perpGross = 0, spotGross = 0;
      for (const [id, [buy, sell]] of flows) {
        const kind = KINDS.get(id.slice(0, id.indexOf(':')));
        if (kind === 'perp') { perpNet += buy - sell; perpGross += buy + sell; } else if (kind === 'spot') { spotNet += buy - sell; spotGross += buy + sell; }
      }
      v.perpNet[i] = perpNet; v.spotNet[i] = spotNet; v.perpGross[i] = perpGross; v.spotGross[i] = spotGross;
    }
    const venue = this.ref.slice(0, this.ref.indexOf(':'));
    const refSpot = flows.find(([id]) => id.startsWith(`${venue}spot:`))?.[1], coinbase = flows.find(([id]) => id.startsWith('coinbase:'))?.[1], refFlow = m.flow[this.ref];
    if (refFlow) v.refNet[i] = refFlow[0] - refFlow[1];
    if (refSpot) v.refSpotNet[i] = refSpot[0] - refSpot[1];
    const spotPx = refSpot?.[2] || NaN;
    v.premium[i] = ((coinbase?.[2] || NaN) - spotPx) / spotPx * 1e4;
    v.basis[i] = ((refFlow?.[2] || NaN) - spotPx) / spotPx * 1e4;
    let long = 0, short = 0, largest = 0, largestPrice = NaN;
    for (const [, , side, usd, price] of m.liq) { if (side === 'long') long += usd; else short += usd; if (usd > largest) { largest = usd; largestPrice = price; } }
    v.liqLong[i] = long; v.liqShort[i] = short; v.liqMax[i] = largest; v.liqMaxPrice[i] = largestPrice;
    const books = Object.values(m.depth), within50 = BANDS_BP.indexOf(50) + 1;
    if (books.length) {
      v.bid50[i] = books.reduce((s, b) => s + b.slice(0, within50).reduce((x, y) => x + y, 0), 0);
      v.ask50[i] = books.reduce((s, b) => s + b.slice(BANDS_BP.length, BANDS_BP.length + within50).reduce((x, y) => x + y, 0), 0);
    }
    const g = m.grid;
    if (g && c) {
      const bidAt = (k: number): number => g.perpBid[k]! + g.spotBid[k]!, askAt = (k: number): number => g.perpAsk[k]! + g.spotAsk[k]!;
      let topBid = -1, topAsk = -1;
      for (let k = 0; k < g.perpBid.length; k++) {
        const low = g.from + k * CELL_USD;
        if (low + CELL_USD <= c.c && low >= c.c * 0.99 && (topBid < 0 || bidAt(k) > bidAt(topBid))) topBid = k;
        if (low >= c.c && low + CELL_USD <= c.c * 1.01 && (topAsk < 0 || askAt(k) > askAt(topAsk))) topAsk = k;
      }
      if (topBid >= 0) { v.topBid[i] = g.from + topBid * CELL_USD; v.topBidUsd[i] = bidAt(topBid); }
      if (topAsk >= 0) { v.topAsk[i] = g.from + topAsk * CELL_USD; v.topAskUsd[i] = askAt(topAsk); }
      // Resting USD added and pulled since the minute before, at prices neither minute traded: bids below both lows, asks above both highs.
      const prev = this.#last;
      if (prev && prev.i === i - 1) {
        let bidAdd = 0, bidPull = 0, askAdd = 0, askPull = 0;
        const shift = Math.round((g.from - prev.grid.from) / CELL_USD), low = Math.min(c.l, prev.l), high = Math.max(c.h, prev.h);
        for (let k = 0; k < g.perpBid.length; k++) {
          const j = k + shift, cellLow = g.from + k * CELL_USD;
          if (j < 0 || j >= prev.grid.perpBid.length) continue;
          if (cellLow + CELL_USD <= low) { const d = bidAt(k) - prev.grid.perpBid[j]! - prev.grid.spotBid[j]!; if (d > 0) bidAdd += d; else bidPull -= d; }
          if (cellLow >= high) { const d = askAt(k) - prev.grid.perpAsk[j]! - prev.grid.spotAsk[j]!; if (d > 0) askAdd += d; else askPull -= d; }
        }
        v.bidAdd[i] = bidAdd; v.bidPull[i] = bidPull; v.askAdd[i] = askAdd; v.askPull[i] = askPull;
      }
      this.#last = { i, grid: g, l: c.l, h: c.h };
    }
    const oi = m.oi[this.ref];
    if (oi) v.oi[i] = oi[1] ?? (c ? oi[0] * c.c : NaN);
    const row = m.reading;
    if (!row) return;
    const put = (model: Model, x: Row['verdict']): void => {
      if (!x || typeof x.score !== 'number') return;
      const a = this.calls[model];
      a.score[i] = x.score; a.dir[i] = x.direction === 'up' ? 1 : -1; a.p[i] = x.directionP; a.loud[i] = x.score >= LOUD ? 1 : 0;
    };
    put('jev', row.verdict);
    for (const arm of SUBQ_ARMS) put(arm, row.arms?.[arm]);
    if (row.verdict) v.cascade[i] = row.verdict.concepts.liquidationCascade ?? NaN;
    const cf = confluence(row.features.values), a = this.calls.confluence;
    a.score[i] = Math.abs(cf.score); a.dir[i] = cf.direction === 'up' ? 1 : cf.direction === 'down' ? -1 : NaN; a.loud[i] = cf.call ? 1 : 0;
  }
}

/** A move as indices into the minutes: its swing from `start` to `end` (`move` apart in price), and the volatile minutes behind it. */
export interface Swing { up: boolean; start: number; end: number; move: number; first: number; last: number; volatileMinutes: number }

/**
 * The moves in a run of minutes. `volatile[i]`: null, or whether the volatile move after minute i is up; `h`, `l`: candle highs and lows (NaN: no
 * candle). Volatile minutes of one direction at most `gap` minutes apart are one move, measured by its swing: the largest run that way, from a
 * low to a later high for a rise (a high to a later low for a fall), from `lead` minutes before its first volatile minute to `trail` after its
 * last. Moves of one direction whose swings overlap are one move; a rise may overlap a fall (a flush and its bounce).
 */
export function findSwings(volatile: readonly (boolean | null)[], h: readonly number[], l: readonly number[], gap = GAP, lead = LEAD, trail = TRAIL): Swing[] {
  const out: Swing[] = [];
  for (const up of [true, false]) {
    const swingOf = (first: number, last: number, count: number): Swing | null => {
      let best: Swing | null = null, pivot = -1;
      for (let i = Math.max(0, first - lead); i <= Math.min(h.length - 1, last + trail); i++) {
        if (!(h[i]! > 0 && l[i]! > 0)) continue;
        // A level held for several minutes: the move starts at the last of them.
        if (pivot < 0 || (up ? l[i]! <= l[pivot]! : h[i]! >= h[pivot]!)) pivot = i;
        const move = up ? h[i]! - l[pivot]! : h[pivot]! - l[i]!;
        if (!best || move > best.move) best = { up, start: pivot, end: i, move, first, last, volatileMinutes: count };
      }
      return best && best.move > 0 ? best : null;
    };
    const moves: Swing[] = [];
    const close = (first: number, last: number, count: number): void => {
      let s = swingOf(first, last, count);
      while (s && moves.length && s.start <= moves.at(-1)!.end) { const p = moves.pop()!; s = swingOf(Math.min(p.first, s.first), Math.max(p.last, s.last), p.volatileMinutes + s.volatileMinutes) ?? p; }
      if (s) moves.push(s);
    };
    let first = -1, last = -1, count = 0;
    for (let i = 0; i < volatile.length; i++) {
      if (volatile[i] !== up) continue;
      if (first >= 0 && i - last <= gap) { last = i; count++; continue; }
      if (first >= 0) close(first, last, count);
      first = last = i; count = 1;
    }
    if (first >= 0) close(first, last, count);
    out.push(...moves);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

type N = number | null;
/** What the minutes up to one showed (`docs/volatility-watch.md` explains each). */
interface Before {
  ret: N; range: N; rangeSigma: N; perpNet: N; spotNet: N; refNet: N; refSpotNet: N; perpZ: N; spotZ: N; spotShare: N; spotShareRatio: N;
  liqLong: N; liqShort: N; liqMax: N; bid50: N; ask50: N; bid50Chg: N; ask50Chg: N; imb50: N; bidAdded: N; bidPulled: N; askAdded: N; askPulled: N;
  belowHigh2h: N; aboveLow2h: N; premium: N; premiumChg: N; basis: N; basisChg: N; oiChg: N;
}
interface During {
  perpNet: N; spotNet: N; refNet: N; spotShare: N; liqLong: N; liqShort: N; liqMax: N; liqMaxBeforeEnd: N; bid50Chg: N; ask50Chg: N; endNet: N; endWick: N;
}
interface After { back5: N; back15: N; back30: N; perpNet5: N }
interface Call { score: number; dir: 'up' | 'down' | null; p: N; loud: boolean; cascade?: N }
type Calls5 = Partial<Record<Model, Call>>;
interface Episode {
  id: string; direction: 'up' | 'down'; start: { t: string; price: number }; end: { t: string; price: number }; minutes: number;
  moveUsd: number; movePct: N; sigmaPct: N; sizeSigma: N; strong: boolean; firstVolatile: string; lastVolatile: string; volatileMinutes: number;
  before10: Before | null; before30: Before | null; during: During; after: After | null;
  calls: { before10: Calls5; before: Calls5; in3: Calls5; atEnd: Calls5 };
  warned: Model[]; caught: Model[];
}
interface Alarm { model: Model; made: string; score: number; dir: 'up' | 'down' | null; p: N; outcome: 'early' | 'during' | 'late' | 'false'; move: string | null }

const fin = Number.isFinite;
const r = (x: number, d = 1): N => fin(x) ? Number(x.toFixed(d)) : null;
const mUsd = (x: number): N => r(x / 1e6, 2);
const median = (xs: readonly number[]): number => { const a = xs.filter(fin).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2) : NaN; };
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const hm = (t: number): string => new Date(t).toISOString().slice(11, 16);
const usd = (x: number): string => `$${Math.round(x).toLocaleString('en-US')}`;

/** The measures of moves and minutes over one series; `sd`: per minute, the sigma of 15-minute log returns it was labelled by. */
class Casebook {
  readonly sums: Record<Summed, Float64Array>;
  readonly recorded: Float64Array;
  constructor(readonly s: Series, readonly sd: readonly number[]) {
    const prefix = (a: readonly number[]): Float64Array => { const p = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) p[i + 1] = p[i]! + (fin(a[i]!) ? a[i]! : 0); return p; };
    this.sums = Object.fromEntries(SUMMED.map(k => [k, prefix(s.v[k])])) as Record<Summed, Float64Array>;
    this.recorded = prefix(s.v.perpGross.map((x, i) => (x > 0 && s.v.c[i]! > 0 ? 1 : 0)));
  }
  sum(k: Summed, a: number, b: number): number { a = Math.max(0, a); b = Math.min(this.s.length - 1, b); return b < a ? 0 : this.sums[k][b + 1]! - this.sums[k][a]!; }
  /** The value at `i`, or the nearest before it within `reach` minutes. */
  near(k: Field, i: number, reach = 3): number { for (let j = i; j >= Math.max(0, i - reach); j--) if (fin(this.s.v[k][j]!)) return this.s.v[k][j]!; return NaN; }
  extreme(k: 'h' | 'l', a: number, b: number): number {
    let x = k === 'h' ? -Infinity : Infinity;
    for (let i = Math.max(0, a); i <= Math.min(this.s.length - 1, b); i++) { const y = this.s.v[k][i]!; if (k === 'h' ? y > x : y < x) x = y; }
    return fin(x) ? x : NaN;
  }
  share(a: number, b: number): number { const sp = this.sum('spotGross', a, b), pp = this.sum('perpGross', a, b); return sp + pp > 0 ? sp / (sp + pp) * 100 : NaN; }
  range(a: number, b: number): number { const hi = this.extreme('h', a, b), lo = this.extreme('l', a, b); return (hi - lo) / lo * 1e4; }

  /** The `w` minutes up to and including `end`, all known as it closed; null when under 80 % of them were recorded. */
  window(end: number, w: number): Before | null {
    const a = end - w + 1, b = end;
    if (a < 1 || b >= this.s.length || this.recorded[b + 1]! - this.recorded[a]! < 0.8 * w) return null;
    const c1 = this.near('c', b), c0 = this.near('c', a - 1);
    if (!(c1 > 0 && c0 > 0)) return null;
    // Against the same window every 5 minutes over the 24 hours before it.
    const z = (k: Summed): number => {
      const xs: number[] = [];
      for (let e = a - 1; e >= Math.max(w, b - 1440); e -= 5) xs.push(this.sum(k, e - w + 1, e));
      const m = mean(xs), sd = Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
      return xs.length >= 24 && sd > 0 ? (this.sum(k, a, b) - m) / sd : NaN;
    };
    const bid1 = this.near('bid50', b), bid0 = this.near('bid50', a - 1), ask1 = this.near('ask50', b), ask0 = this.near('ask50', a - 1);
    const hi2 = this.extreme('h', b - 119, b), lo2 = this.extreme('l', b - 119, b), range = this.range(a, b), share = this.share(a, b);
    const prem1 = this.near('premium', b), prem0 = this.near('premium', a - 1), basis1 = this.near('basis', b), basis0 = this.near('basis', a - 1);
    return {
      ret: r(Math.log(c1 / c0) * 1e4), range: r(range), rangeSigma: r(range / 1e4 / nearSd(this.sd, b), 2),
      perpNet: mUsd(this.sum('perpNet', a, b)), spotNet: mUsd(this.sum('spotNet', a, b)), refNet: mUsd(this.sum('refNet', a, b)), refSpotNet: mUsd(this.sum('refSpotNet', a, b)),
      perpZ: r(z('perpNet'), 2), spotZ: r(z('spotNet'), 2), spotShare: r(share), spotShareRatio: r(share / this.share(b - 1440, a - 1), 2),
      liqLong: mUsd(this.sum('liqLong', a, b)), liqShort: mUsd(this.sum('liqShort', a, b)), liqMax: mUsd(Math.max(0, ...this.s.v.liqMax.slice(a, b + 1).filter(fin))),
      bid50: mUsd(bid1), ask50: mUsd(ask1), bid50Chg: r((bid1 / bid0 - 1) * 100), ask50Chg: r((ask1 / ask0 - 1) * 100), imb50: r((bid1 - ask1) / (bid1 + ask1), 3),
      bidAdded: mUsd(this.sum('bidAdd', a, b)), bidPulled: mUsd(this.sum('bidPull', a, b)), askAdded: mUsd(this.sum('askAdd', a, b)), askPulled: mUsd(this.sum('askPull', a, b)),
      belowHigh2h: r((hi2 - c1) / c1 * 1e4), aboveLow2h: r((c1 - lo2) / c1 * 1e4),
      premium: r(prem1, 2), premiumChg: r(prem1 - prem0, 2), basis: r(basis1, 2), basisChg: r(basis1 - basis0, 2), oiChg: r((this.near('oi', b) / this.near('oi', a - 1) - 1) * 100, 3),
    };
  }

  during(m: Swing): During {
    const { start: a, end: b } = m, v = this.s.v;
    let largest = 0, at = -1;
    for (let k = a; k <= b; k++) if (v.liqMax[k]! > largest) { largest = v.liqMax[k]!; at = k; }
    return {
      perpNet: mUsd(this.sum('perpNet', a, b)), spotNet: mUsd(this.sum('spotNet', a, b)), refNet: mUsd(this.sum('refNet', a, b)), spotShare: r(this.share(a, b)),
      liqLong: mUsd(this.sum('liqLong', a, b)), liqShort: mUsd(this.sum('liqShort', a, b)), liqMax: mUsd(largest), liqMaxBeforeEnd: at >= 0 ? b - at : null,
      bid50Chg: r((this.near('bid50', b) / this.near('bid50', a - 1) - 1) * 100), ask50Chg: r((this.near('ask50', b) / this.near('ask50', a - 1) - 1) * 100),
      endNet: mUsd(v.perpNet[b]!), endWick: r(m.up ? (v.h[b]! - v.c[b]!) / v.h[b]! * 1e4 : (v.c[b]! - v.l[b]!) / v.l[b]! * 1e4),
    };
  }

  /** The 30 minutes after the move's end; null until they are recorded. */
  after(m: Swing): After | null {
    const b = m.end, v = this.s.v;
    if (b + 30 >= this.s.length) return null;
    const from = m.up ? v.l[m.start]! : v.h[m.start]!, to = m.up ? v.h[b]! : v.l[b]!;
    const back = (k: number): N => r((to - this.near('c', b + k)) / (to - from) * 100);
    return { back5: back(5), back15: back(15), back30: back(30), perpNet5: mUsd(this.sum('perpNet', b + 1, b + 5)) };
  }

  /** The readings made as minute `i` closed. */
  calls(i: number): Calls5 {
    const out: Calls5 = {};
    if (i < 0 || i >= this.s.length) return out;
    for (const model of MODELS) {
      const a = this.s.calls[model];
      if (fin(a.score[i]!)) out[model] = { score: r(a.score[i]!, 2)!, dir: a.dir[i] === 1 ? 'up' : a.dir[i] === -1 ? 'down' : null, p: r(a.p[i]!, 2), loud: a.loud[i] === 1 };
    }
    if (out.jev && fin(this.s.v.cascade[i]!)) out.jev.cascade = r(this.s.v.cascade[i]!, 2);
    return out;
  }
  loud(model: Model, a: number, b: number): boolean { for (let i = Math.max(0, a); i <= Math.min(this.s.length - 1, b); i++) if (this.s.calls[model].loud[i] === 1) return true; return false; }
}

const pct = (k: number, n: number): string => n ? `${k}/${n} ${Math.round(k / n * 100)} %` : '-';
const cell = (x: N | undefined, d = 1): string => (x === null || x === undefined ? '-' : x.toFixed(d));
const callText = (c: Call | undefined, up?: boolean): string => c ? `${c.dir === 'up' ? 'UP' : c.dir === 'down' ? 'DN' : '--'}${c.p === null ? '' : Math.round(c.p * 100)}${up === undefined || c.dir === null ? '' : (c.dir === 'up') === up ? '+' : 'x'}` : '-';

/** Signed readings (positive points up), compared with the side price touched first. */
const SIGNED: [string, (b: Before) => N][] = [
  ['price change', b => b.ret],
  ['net taker USD, all perpetuals', b => b.perpNet],
  ['net taker USD, all spot', b => b.spotNet],
  ['net taker USD, reference perpetual', b => b.refNet],
  ['net taker USD, its venue\'s spot', b => b.refSpotNet],
  ['shorts liquidated minus longs', b => (b.liqShort === null || b.liqLong === null ? null : b.liqShort - b.liqLong)],
  ['book within 50 bp: bids over asks', b => b.imb50],
  ['within 50 bp: bids grew more than asks', b => (b.bid50Chg === null || b.ask50Chg === null ? null : b.bid50Chg - b.ask50Chg)],
  ['away from price: bids stacked, asks pulled', b => (b.bidAdded === null || b.bidPulled === null || b.askAdded === null || b.askPulled === null ? null : b.bidAdded - b.bidPulled - b.askAdded + b.askPulled)],
  ['nearer the 2-hour high than the low', b => (b.aboveLow2h === null || b.belowHigh2h === null ? null : b.aboveLow2h - b.belowHigh2h)],
  ['Coinbase over Binance spot', b => b.premium],
  ['that premium rising', b => b.premiumChg],
  ['perpetual over spot (basis) rising', b => b.basisChg],
];
/** Unsigned readings, compared between minutes after which price moved and minutes after which it did not. */
const UNSIGNED: [string, (b: Before) => N][] = [
  ['|price change| (bp)', b => (b.ret === null ? null : Math.abs(b.ret))],
  ['range (sigma of 15-minute returns)', b => b.rangeSigma],
  ['|perpetual flow z|', b => (b.perpZ === null ? null : Math.abs(b.perpZ))],
  ['|spot flow z|', b => (b.spotZ === null ? null : Math.abs(b.spotZ))],
  ['spot share against the day before (x)', b => b.spotShareRatio],
  ['liquidations, both sides ($M)', b => (b.liqLong === null || b.liqShort === null ? null : b.liqLong + b.liqShort)],
  ['|bids within 50 bp changed| (%)', b => (b.bid50Chg === null ? null : Math.abs(b.bid50Chg))],
  ['|asks within 50 bp changed| (%)', b => (b.ask50Chg === null ? null : Math.abs(b.ask50Chg))],
  ['|book imbalance within 50 bp|', b => (b.imb50 === null ? null : Math.abs(b.imb50))],
  ['resting USD moved away from price ($M)', b => (b.bidAdded === null || b.bidPulled === null || b.askAdded === null || b.askPulled === null ? null : b.bidAdded + b.bidPulled + b.askAdded + b.askPulled)],
  ['|Coinbase premium change| (bp)', b => (b.premiumChg === null ? null : Math.abs(b.premiumChg))],
  ['|basis change| (bp)', b => (b.basisChg === null ? null : Math.abs(b.basisChg))],
  ['|open interest change| (%)', b => (b.oiChg === null ? null : Math.abs(b.oiChg))],
];

/** The non-null values of `f` over `xs`. */
function vals<T>(xs: readonly T[], f: (x: T) => N): number[] { return xs.map(f).filter((x): x is number => x !== null); }

/**
 * What price did after minute i: 1 when it touched K sigma above the close first within HORIZON minutes, -1 below, 2 both within one
 * minute, 0 neither; NaN when the sigma or too many of those minutes are missing.
 */
function touched(s: Series, sd: readonly number[], i: number): number {
  const c0 = s.v.c[i]!, sigma = nearSd(sd, i);
  if (!(c0 > 0 && sigma > 0) || i + HORIZON >= s.length) return NaN;
  const up = c0 * Math.exp(K * sigma), down = c0 * Math.exp(-K * sigma);
  let seen = 0;
  for (let k = i + 1; k <= i + HORIZON; k++) {
    if (!(s.v.h[k]! > 0)) continue;
    seen++;
    const high = s.v.h[k]! >= up, low = s.v.l[k]! <= down;
    if (high || low) return high && low ? 2 : high ? 1 : -1;
  }
  return seen >= HORIZON - 3 ? 0 : NaN;
}

/** Separate events among minute indices (ascending): runs at most 5 minutes apart. */
function events(minutes: readonly number[]): number { return minutes.filter((i, k) => k === 0 || i - minutes[k - 1]! > 5).length; }

/** The share of hits, with a 95 % range treating each hour as one cluster (neighbouring minutes are not independent). */
function share(minutes: readonly number[], hits: readonly boolean[]): string {
  const n = hits.length, k = hits.filter(Boolean).length;
  if (!n) return '-';
  const p = k / n, blocks = new Map<number, [number, number]>();
  minutes.forEach((i, j) => { const b = blocks.get(Math.floor(i / 60)) ?? [0, 0]; b[0] += hits[j] ? 1 : 0; b[1]++; blocks.set(Math.floor(i / 60), b); });
  const B = blocks.size, se = B > 1 ? Math.sqrt(B / (B - 1) * [...blocks.values()].reduce((a, [hit, all]) => a + (hit - p * all) ** 2, 0)) / n : NaN;
  return `${Math.round(p * 100)} % of ${n}${B >= 5 ? ` [${Math.max(0, Math.round((p - 1.96 * se) * 100))}-${Math.min(100, Math.round((p + 1.96 * se) * 100))}]` : ''}`;
}

/**
 * The readings against what came next, over every minute rather than the moves: a move's start is a turning point found afterwards, so the
 * minutes before it ran the other way by construction. Each reading is the one known as the minute closed.
 */
function minuteTables(s: Series, book: Casebook): string[] {
  const n = s.length, next = new Float64Array(n), known: number[] = [];
  for (let i = 0; i < n; i++) { next[i] = touched(s, book.sd, i); if (fin(next[i]!)) known.push(i); }
  const columns = new Map<string, Float64Array>();
  for (const w of [10, 30]) {
    const signed = SIGNED.map(([name]) => { const a = new Float64Array(n).fill(NaN); columns.set(`s ${name} ${w}`, a); return a; });
    const unsigned = UNSIGNED.map(([name]) => { const a = new Float64Array(n).fill(NaN); columns.set(`u ${name} ${w}`, a); return a; });
    for (const i of known) {
      const b = book.window(i, w);
      if (!b) continue;
      SIGNED.forEach(([, f], k) => { signed[k]![i] = f(b) ?? NaN; });
      UNSIGNED.forEach(([, f], k) => { unsigned[k]![i] = f(b) ?? NaN; });
    }
  }
  const moved = known.filter(i => next[i] !== 0), up = known.filter(i => next[i] === 1), down = known.filter(i => next[i] === -1);
  const L: string[] = [];
  L.push('', `== 3. Brewing, every minute: does a reading tell that price will touch ${K} sigma (either way) within ${HORIZON} minutes?`);
  L.push(`   ${moved.length} of ${known.length} minutes did (${Math.round(moved.length / Math.max(1, known.length) * 100)} %, ${events(moved)} separate events). AUC: the chance that such a minute's reading is`);
  L.push('   the larger against one that did not (0.5: a coin). The models\' scores are their readings made as the minute closed.');
  L.push(`${'reading'.padEnd(42)} ${'last 10 min'.padStart(11)} ${'last 30 min'.padStart(11)}`);
  const aucOf = (values: Float64Array | number[]): string => {
    const xs = known.filter(i => fin(values[i]!)), x = auc(xs.map(i => values[i]!), xs.map(i => next[i] !== 0));
    return x === null ? '-' : x.toFixed(2);
  };
  for (const [name] of UNSIGNED) L.push(`${name.padEnd(42)} ${aucOf(columns.get(`u ${name} 10`)!).padStart(11)} ${aucOf(columns.get(`u ${name} 30`)!).padStart(11)}`);
  for (const model of MODELS) if (s.calls[model].score.some(fin)) L.push(`${`${NAMES[model]} score`.padEnd(42)} ${aucOf(s.calls[model].score).padStart(11)}`);

  const sided = known.filter(i => next[i] === 1 || next[i] === -1);
  L.push('', `== 4. Direction, every minute that moved: of the minutes after which price touched ${K} sigma on one side first (${up.length} up, ${down.length} down;`);
  L.push(`   ${events(sided)} separate events), the share where the reading pointed to that side, with a 95 % range. Far below 50 % points the other way.`);
  L.push(`${'reading (positive = points up)'.padEnd(42)} ${'last 10 min'.padEnd(22)} last 30 min`);
  const agreement = (values: Float64Array | number[]): string => {
    const xs = sided.filter(i => fin(values[i]!) && values[i] !== 0);
    return share(xs, xs.map(i => (values[i]! > 0) === (next[i] === 1)));
  };
  for (const [name] of SIGNED) L.push(`${name.padEnd(42)} ${agreement(columns.get(`s ${name} 10`)!).padEnd(22)} ${agreement(columns.get(`s ${name} 30`)!)}`);
  for (const model of MODELS) if (s.calls[model].dir.some(fin)) L.push(`${`${NAMES[model]} direction`.padEnd(42)} ${agreement(s.calls[model].dir)}`);
  return L;
}

function summary(s: Series, book: Casebook, episodes: Episode[], alarms: Alarm[], now: number): string {
  const L: string[] = [];
  const recorded = s.v.c.filter(fin).length, read = s.calls.confluence.score.filter(fin).length;
  const ups = episodes.filter(e => e.direction === 'up'), strong = episodes.filter(e => e.strong);
  L.push(`VOLATILITY CASEBOOK, rebuilt ${iso(now)} UTC (scripts/volatility-episodes.mts; definitions in docs/volatility-watch.md). All times UTC.`);
  L.push(`Minutes: ${iso(s.time(0))} to ${iso(s.time(s.length - 1))}, ${recorded} with a ${s.ref} candle, ${read} with a model reading.`);
  L.push(`A move: minutes after which ${s.ref} closes ${K} sigma of 15-minute returns away within ${HORIZON} minutes (sigma over the 24 h before),`);
  L.push(`one direction, at most ${GAP} minutes apart; measured on 1-minute candles from the high a fall starts at (the low a rise starts at) to where`);
  L.push(`it ends. Strong: one of its minutes reached ${STRONG_K} sigma (the daily evaluation's volatile move). A reading made "as minute M closed" saw up to M's end.`);
  L.push('');
  L.push(`MOVES ${episodes.length}: ${ups.length} up, ${episodes.length - ups.length} down; strong ${strong.length} (${strong.filter(e => e.direction === 'up').length} up). Median ${cell(median(episodes.map(e => (e.movePct === null ? NaN : Math.abs(e.movePct)))), 2)} % (${cell(median(episodes.map(e => e.sizeSigma ?? NaN)))} sigma) in ${median(episodes.map(e => e.minutes))} min.`);

  L.push('', '== 1. The moves, newest first (S = strong). Readings made 3 minutes in: + right way, x wrong way.');
  L.push('start             end    dir   from        to          move                 sigma  min   liq long / short $M   3 min in: Jev   SubQ   +image  Conf   | loud in the 15 min before');
  for (const e of [...episodes].reverse()) {
    const up = e.direction === 'up', c = e.calls.in3;
    L.push(`${e.start.t}  ${e.end.t.slice(11)}  ${up ? 'UP  ' : 'DOWN'}  ${usd(e.start.price).padEnd(10)}  ${usd(e.end.price).padEnd(10)}  ${(up ? '+' : '-') + usd(Math.abs(e.moveUsd))} (${cell(e.movePct, 2)} %)`.padEnd(96)
      + `${cell(e.sizeSigma).padStart(4)}${e.strong ? ' S' : '  '}  ${String(e.minutes).padStart(3)}   ${cell(e.during.liqLong).padStart(6)} / ${cell(e.during.liqShort).padEnd(6)}     ${callText(c.jev, up).padEnd(6)}  ${callText(c.subq, up).padEnd(6)} ${callText(c.subqImage, up).padEnd(6)}  ${callText(c.confluence, up).padEnd(5)}  | ${e.warned.map(m => NAMES[m]).join(', ') || '-'}`);
  }

  L.push('', '== 2. The models around the moves. Warned: a loud reading (score 3+ of 4; the confluence: a call) in the 15 minutes before the move');
  L.push('   started; caught: one in its first 5 minutes. Direction at the turning point (the reading made as the minute before the start closed;');
  L.push('   price had just run the other way, so this is not the models\' direction skill: see 4) and 3 minutes in. Loud readings (a new one after');
  L.push('   5 quiet minutes): before a move (within 15 min), during one, just after one (15 min), or with nothing.');
  L.push(`${'model'.padEnd(13)} ${'warned'.padEnd(14)} ${'caught'.padEnd(14)} ${'turning point'.padEnd(18)} ${'3 min in'.padEnd(18)} loud  before  during  after  nothing`);
  for (const model of MODELS) {
    const asked = episodes.filter(e => e.calls.before[model] || e.calls.in3[model]);
    if (!asked.length) continue;
    const dirOk = (k: 'before' | 'in3'): string => { const xs = asked.filter(e => e.calls[k][model]?.dir); return pct(xs.filter(e => e.calls[k][model]!.dir === e.direction).length, xs.length); };
    const mine = alarms.filter(a => a.model === model), n = (o: Alarm['outcome']): number => mine.filter(a => a.outcome === o).length;
    L.push(`${NAMES[model].padEnd(13)} ${pct(asked.filter(e => e.warned.includes(model)).length, asked.length).padEnd(14)} ${pct(asked.filter(e => e.caught.includes(model)).length, asked.length).padEnd(14)} ${dirOk('before').padEnd(18)} ${dirOk('in3').padEnd(18)} ${String(mine.length).padStart(4)}  ${String(n('early')).padStart(6)}  ${String(n('during')).padStart(6)}  ${String(n('late')).padStart(5)}  ${String(n('false')).padStart(7)}`);
  }

  L.push(...minuteTables(s, book));

  L.push('', '== 5. During and after (medians): up moves | down moves. Flows signed (+ = buying); the end wick is how far the end minute closed back.');
  const by = (f: (e: Episode) => N): string => `${cell(median(vals(ups, f)), 2).padStart(8)} | ${cell(median(vals(episodes.filter(e => e.direction === 'down'), f)), 2).padStart(8)}`;
  const rows: [string, (e: Episode) => N][] = [
    ['size (%)', e => e.movePct === null ? null : Math.abs(e.movePct)], ['size (sigma)', e => e.sizeSigma], ['minutes', e => e.minutes],
    ['net taker USD, all perpetuals ($M)', e => e.during.perpNet], ['net taker USD, all spot ($M)', e => e.during.spotNet], ['spot share (%)', e => e.during.spotShare],
    ['longs liquidated ($M)', e => e.during.liqLong], ['shorts liquidated ($M)', e => e.during.liqShort], ['largest liquidation ($M)', e => e.during.liqMax],
    ['  its minutes before the end', e => e.during.liqMaxBeforeEnd], ['bids within 50 bp changed (%)', e => e.during.bid50Chg], ['asks within 50 bp changed (%)', e => e.during.ask50Chg],
    ['end minute: net perpetual USD ($M)', e => e.during.endNet], ['end minute: wick back (bp)', e => e.during.endWick],
    ['given back 5 min after (% of move)', e => e.after?.back5 ?? null], ['given back 15 min after', e => e.after?.back15 ?? null], ['given back 30 min after', e => e.after?.back30 ?? null],
    ['net perpetual USD, 5 min after ($M)', e => e.after?.perpNet5 ?? null],
  ];
  for (const [name, f] of rows) L.push(`${name.padEnd(40)} ${by(f)}`);
  return L.join('\n') + '\n';
}

function caseText(s: Series, book: Casebook, e: Episode, m: Swing): string {
  const v = s.v, up = m.up, L: string[] = [];
  L.push(`MOVE ${e.id}: ${up ? 'UP' : 'DOWN'} from ${usd(e.start.price)} (${e.start.t.slice(11)}) to ${usd(e.end.price)} (${e.end.t.slice(11)} UTC), ${up ? '+' : '-'}${usd(Math.abs(e.moveUsd))} (${cell(e.movePct, 2)} %), ${cell(e.sizeSigma)} sigma${e.strong ? ' (strong)' : ''}, ${e.minutes} min.`);
  L.push(`Volatile minutes ${e.firstVolatile.slice(11)} to ${e.lastVolatile.slice(11)} (${e.volatileMinutes}). ${e.after ? `Given back: ${cell(e.after.back5, 0)} % after 5 min, ${cell(e.after.back15, 0)} % after 15, ${cell(e.after.back30, 0)} % after 30.` : 'Too recent for what came after.'}`);
  L.push(`Loud in the 15 min before: ${e.warned.map(x => NAMES[x]).join(', ') || 'none'}; in the first 5 min: ${e.caught.map(x => NAMES[x]).join(', ') || 'none'}.`);
  const b30 = e.before30, b10 = e.before10;
  if (b30 && b10) L.push(`Before the start (30 min | 10 min; it is a turning point, so price ran the other way into it): price ${cell(b30.ret, 0)} | ${cell(b10.ret, 0)} bp; perpetual net ${cell(b30.perpNet)} | ${cell(b10.perpNet)} $M (z ${cell(b30.perpZ)} | ${cell(b10.perpZ)}); spot net ${cell(b30.spotNet)} | ${cell(b10.spotNet)} $M; range ${cell(b30.rangeSigma)} | ${cell(b10.rangeSigma)} sigma; liquidations long ${cell(b30.liqLong)} short ${cell(b30.liqShort)} $M; book within 50 bp bids ${cell(b30.bid50Chg, 0)} % asks ${cell(b30.ask50Chg, 0)} %; OI ${cell(b30.oiChg, 2)} %.`);
  L.push('Each row is a 1-minute candle (UTC). Liq: longs / shorts liquidated ($M, largest order and its price). Net: taker buy minus sell ($M).');
  L.push('Book: resting USD within 50 bp of each book\'s middle, all 11 books ($M); top bid / ask: the largest $50 cell within 1 % ($M). Readings: made as the minute closed.');
  L.push('');
  L.push('UTC    open    high    low     close  | liq long/short (largest)  | net: ref  perps   spot | spot% | book bid  ask  | top bid         top ask         | OI %   | Jev     LC  | SubQ   +image Conf');
  const oi0 = book.near('oi', m.start - 31, 30);
  const from = Math.max(0, m.start - 30), to = Math.min(s.length - 1, m.end + 30, from + 150);
  for (let i = from; i <= to; i++) {
    const c = book.calls(i), j = c.jev;
    const mark = i === m.start ? (up ? '  < start (low)' : '  < start (high)') : i === m.end ? (up ? '  < end (high)' : '  < end (low)') : i === m.first ? '  < first volatile minute' : '';
    const gross = v.perpGross[i]! + v.spotGross[i]!;
    const big = v.liqMax[i]! >= 1e5 ? ` (${(v.liqMax[i]! / 1e6).toFixed(1)} @${Math.round(v.liqMaxPrice[i]!)})` : '';
    L.push(`${hm(s.time(i))}  ${cell(v.o[i], 0).padStart(6)}  ${cell(v.h[i], 0).padStart(6)}  ${cell(v.l[i], 0).padStart(6)}  ${cell(v.c[i], 0).padStart(6)} | ${cell(r(v.liqLong[i]! / 1e6, 1)).padStart(5)}/${cell(r(v.liqShort[i]! / 1e6, 1)).padEnd(5)}${big.padEnd(16)} | ${cell(r(v.refNet[i]! / 1e6, 1)).padStart(8)} ${cell(r(v.perpNet[i]! / 1e6, 1)).padStart(6)} ${cell(r(v.spotNet[i]! / 1e6, 1)).padStart(6)} | ${cell(r(v.spotGross[i]! / gross * 100, 0), 0).padStart(4)}  | ${cell(r(v.bid50[i]! / 1e6, 0), 0).padStart(8)} ${cell(r(v.ask50[i]! / 1e6, 0), 0).padStart(4)}  | ${fin(v.topBid[i]!) ? `${v.topBid[i]} ${(v.topBidUsd[i]! / 1e6).toFixed(0)}`.padEnd(15) : '-'.padEnd(15)} ${fin(v.topAsk[i]!) ? `${v.topAsk[i]} ${(v.topAskUsd[i]! / 1e6).toFixed(0)}`.padEnd(15) : '-'.padEnd(15)} | ${cell(r((v.oi[i]! / oi0 - 1) * 100, 2), 2).padStart(6)} | ${j ? `${j.score.toFixed(1)} ${callText(j)}`.padEnd(8) : '-'.padEnd(8)}${cell(j?.cascade === undefined || j.cascade === null ? null : j.cascade * 100, 0).padStart(3)} | ${callText(c.subq).padEnd(6)} ${callText(c.subqImage).padEnd(6)} ${c.confluence ? callText(c.confluence) + (c.confluence.loud ? '!' : '') : '-'}${mark}`);
  }
  return L.join('\n') + '\n';
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

function main(): void {
  const data = arg('data', 'data/runtime'), out = arg('out', 'Research_Results/volatility-episodes'), ref = arg('ref', 'binance:BTCUSDT'), coin = arg('coin', 'BTC');
  const now = Date.now(), daysDir = path.join(out, 'minutes');
  const log = new Map(readLog(path.join(data, 'volatility-log.jsonl')).filter(row => row.features.coin === coin).map(row => [row.features.t, row] as const));
  // Opened read-only beside the running server (the installed Node typings predate the option).
  const readOnly: ConstructorParameters<typeof DatabaseSync>[1] & { readOnly: boolean } = { readOnly: true };
  const src: Sources = { history: new DatabaseSync(path.join(data, 'history.sqlite'), readOnly), depth: new DatabaseSync(path.join(data, 'depth-v2.sqlite'), readOnly), log, ref, coin };
  const kept = keepDays(src, daysDir, now);

  const s = new Series(ref);
  for (const file of fs.readdirSync(daysDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f)).sort()) {
    for (const line of zlib.gunzipSync(fs.readFileSync(path.join(daysDir, file))).toString('utf8').split('\n')) if (line) s.add(JSON.parse(line) as Minute);
  }
  for (const m of readMinutes(src, Math.max(kept, now - 7 * DAY), Math.floor(now / MINUTE) * MINUTE - MINUTE)) s.add(m);
  if (!s.length) { console.log('nothing recorded yet'); return; }

  // Volatile minutes on the reference's closes, as the evaluation labels the log's rows.
  const rows = s.v.c.flatMap((c, i) => (c > 0 ? [{ features: { coin, t: s.time(i), price: c, values: {} } }] : []));
  const volatile = new Array<boolean | null>(s.length).fill(null), strong = new Array<boolean | null>(s.length).fill(null), sd = new Array<number>(s.length).fill(NaN);
  for (const l of label(rows, HORIZON, K)) { const i = Math.round((l.row.features.t - s.t0) / MINUTE); sd[i] = l.sd; if (l.volatile) volatile[i] = l.up; }
  for (const l of label(rows, HORIZON, STRONG_K)) if (l.volatile) strong[Math.round((l.row.features.t - s.t0) / MINUTE)] = l.up;

  const book = new Casebook(s, sd), v = s.v;
  const swings = findSwings(volatile, v.h, v.l);
  const idOf = (m: Swing): string => `${new Date(s.time(m.start)).toISOString().slice(0, 16)}Z-${m.up ? 'up' : 'down'}`;
  const episodes: Episode[] = swings.map(m => {
    const from = m.up ? v.l[m.start]! : v.h[m.start]!, to = m.up ? v.h[m.end]! : v.l[m.end]!, sigma = nearSd(sd, m.start);
    let strongMinutes = 0;
    for (let i = m.first; i <= m.last; i++) if (strong[i] === m.up) strongMinutes++;
    return {
      id: idOf(m), direction: m.up ? 'up' : 'down', start: { t: iso(s.time(m.start)), price: from }, end: { t: iso(s.time(m.end)), price: to }, minutes: m.end - m.start,
      moveUsd: Math.round(to - from), movePct: r((to / from - 1) * 100, 3), sigmaPct: r(sigma * 100, 3), sizeSigma: r(Math.abs(Math.log(to / from)) / sigma, 2), strong: strongMinutes > 0,
      firstVolatile: iso(s.time(m.first)), lastVolatile: iso(s.time(m.last)), volatileMinutes: m.volatileMinutes,
      before10: book.window(m.start - 1, 10), before30: book.window(m.start - 1, 30), during: book.during(m), after: book.after(m),
      calls: { before10: book.calls(m.start - 10), before: book.calls(m.start - 1), in3: book.calls(m.start + 2), atEnd: book.calls(m.end) },
      warned: MODELS.filter(model => book.loud(model, m.start - 15, m.start - 1)), caught: MODELS.filter(model => book.loud(model, m.start, m.start + 4)),
    };
  });

  const alarms: Alarm[] = [];
  for (const model of MODELS) {
    let lastLoud = -Infinity;
    for (let i = 0; i < s.length; i++) {
      if (s.calls[model].loud[i] !== 1) continue;
      const fresh = i - lastLoud > 5; lastLoud = i;
      if (!fresh) continue;
      const during = swings.find(m => m.start <= i && i <= m.end), early = swings.find(m => i < m.start && m.start <= i + 15), late = swings.find(m => m.end < i && i <= m.end + 15);
      const move = during ?? early ?? late, c = book.calls(i)[model]!;
      alarms.push({ model, made: iso(s.time(i) + MINUTE), score: c.score, dir: c.dir, p: c.p, outcome: during ? 'during' : early ? 'early' : late ? 'late' : 'false', move: move ? idOf(move) : null });
    }
  }

  fs.mkdirSync(out, { recursive: true });
  const jsonl = (name: string, items: unknown[]): void => fs.writeFileSync(path.join(out, name), items.map(x => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
  jsonl('episodes.jsonl', episodes); jsonl('alarms.jsonl', alarms);
  const cases = path.join(out, 'cases');
  fs.rmSync(cases, { recursive: true, force: true }); fs.mkdirSync(cases);
  episodes.forEach((e, k) => fs.writeFileSync(path.join(cases, `${e.id.replace(':', '')}.txt`), caseText(s, book, e, swings[k]!)));
  fs.writeFileSync(path.join(out, 'summary.txt'), summary(s, book, episodes, alarms, now));
  console.log(`${episodes.length} moves (${episodes.filter(e => e.strong).length} strong), ${alarms.length} loud readings; ${out}/summary.txt`);
}

/** The sigma a minute was labelled by, or that of the nearest labelled minute before it within half an hour. */
function nearSd(sd: readonly number[], i: number): number { for (let j = i; j >= Math.max(0, i - 30); j--) if (fin(sd[j]!)) return sd[j]!; return NaN; }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
