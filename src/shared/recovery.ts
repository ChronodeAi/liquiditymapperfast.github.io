/**
 * Trade recovery: the trades a recording missed (the page was not open, a phone suspended it, a feed reconnected) read back from the venues'
 * public trade history, as its own pipeline beside the live one. Nothing here goes through the live trade callback: the rows are put in
 * exchange-time order per instrument, rebuilt into market orders by a builder of their own, joined to the live recording at an explicit seam
 * (the coverage record's last trade before the gap and first after it, by trade id where a venue's ids rise with time), and handed to the
 * recorders in one step together with the stretch they cover, so a question never sees half a recovery. Recovered trades are never sent to
 * the trade dust or as fresh large orders, so they never flash or sound.
 *
 * The venues (their limits, paging and fields were checked against their documentation and live on 2026-10-16, `Research_Findings.md`):
 * Binance USD-M and spot `aggTrades` page forward from an id or a time; OKX `history-trades` (100 rows a page), Bitget `fills-history` and
 * Coinbase `trades` page back from an id; Bybit `recent-trade` and Hyperliquid `recentTrades` give their latest page only (seconds to a few
 * minutes of BTC), so they recover a short gap or nothing. Deribit and MEXC are not recovered.
 *
 * One recovery action is bounded (`RECOVERY_BUDGET`): at most 20 pages, 20,000 rows or 30 s, two requests in flight, each of the venues'
 * limits (`bucket`: OKX's swap and spot share one endpoint and one limit) paced well inside what it publishes. A gap the budget did not reach stays a gap, visibly.
 */
import type { CoinVenue, Listing } from './coins.ts';
import { complement, firstEndingAfter, type CoverGap, type SeamTrade, type TradeCoverage } from './coverage.ts';
import type { FlowRecorder } from './flow.ts';
import type { FootprintRecorder } from './footprint.ts';
import { OrderBuilder, orderRow, type MarketOrder } from './orders.ts';
import type { PrintStream } from './prints.ts';

const HOUR = 3_600_000, MINUTE = 60_000;

/** A trade read back from a venue's history, as its live connector reports it (price and amount of one coin, the taker's side). */
export interface HistoryTrade { tradeId: string; side: 'buy' | 'sell'; price: number; amount: number; notionalUsd: number; t: number; order?: string }

/** Where a page starts: forward from an id (inclusive) or over a time window; back from an id (older than it, exclusive); null: the newest page. */
export type Cursor = { fromId: string } | { start: number; end: number } | { olderThan: string } | null;
export interface PageRequest { url: string; init?: { method: 'POST'; headers: Record<string, string>; body: string } }

/** One venue's public trade history as recovery reads it. */
export interface HistorySource {
  readonly venue: CoinVenue;
  /**
   * The limit its requests count against: the endpoint, whatever the market (OKX's swap and spot pages are one endpoint with one limit of
   * 20 requests in 2 s, and two of them paced apart once went over it together). Pacing, a failure and the rest after it are per bucket.
   */
  readonly bucket: string;
  /** `forward`: pages run oldest first from an id or a time (Binance); `back`: newest first, each older than the last (OKX, Bitget, Coinbase); `latest`: one page, the newest. */
  readonly mode: 'forward' | 'back' | 'latest';
  /** Trade ids are whole numbers that rise with time, so a seam can be drawn by id. */
  readonly ordered: boolean;
  /** The fewest ms between two requests to the venue, well inside its published limit. */
  readonly paceMs: number;
  /** Rows of a full page. */
  readonly pageRows: number;
  request(cursor: Cursor): PageRequest;
  /** The rows of an answer as trades, in the order the venue gave them; null when the answer is not a page of trades (an error, a rate limit). */
  parse(body: unknown): HistoryTrade[] | null;
}

// ---- Trade ids ------------------------------------------------------------------------------------------------------------------------

const digits = (id: string): string => id.replace(/^0+(?=\d)/, '');
/** Two whole-number ids in their decimal form compared without losing precision (Bitget's run past 2^53). */
export function compareIds(a: string, b: string): number {
  const x = digits(a), y = digits(b);
  return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
}
const isWhole = (id: string): boolean => /^\d+$/.test(id);
const nextId = (id: string): string => (BigInt(id) + 1n).toString();

// ---- The venues ---------------------------------------------------------------------------------------------------------------------

const num = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** A trade from a venue's listed units (`unit` coins per listed unit, `contract` listed units per contract), as the live connector converts it. */
function trade(id: unknown, side: 'buy' | 'sell' | null, price: number, size: number, t: number, unit: number, contract = 1, order?: unknown): HistoryTrade | null {
  const amount = size * contract;
  if (side === null || !(price > 0) || !(amount > 0) || !Number.isFinite(t) || id === undefined || id === null || id === '') return null;
  const key = typeof order === 'string' && order && !/^0x0*$/i.test(order) ? { order } : {};
  return { tradeId: String(id), side, price: price / unit, amount: amount * unit, notionalUsd: price * amount, t, ...key };
}
const rows = (list: unknown, read: (r: Record<string, unknown>) => HistoryTrade | null): HistoryTrade[] | null =>
  Array.isArray(list) ? list.flatMap(item => { const r = rec(item), t = r ? read(r) : null; return t ? [t] : []; }) : null;

/** How to read `venue`'s trade history for a coin it lists as `listing` (null: none a page can read back). */
export function historySource(venue: string, listing: Pick<Listing, 'symbol' | 'unit' | 'contract'>): HistorySource | null {
  const sym = encodeURIComponent(listing.symbol), unit = listing.unit || 1;
  switch (venue) {
    case 'binance': case 'binancespot': {
      const base = venue === 'binance' ? `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${sym}&limit=1000` : `https://api.binance.com/api/v3/aggTrades?symbol=${sym}&limit=1000`;
      return {
        venue, bucket: venue === 'binance' ? 'binance-fapi' : 'binance-api', mode: 'forward', ordered: true, pageRows: 1000,
        // USD-M: weight 20 of 2,400 a minute; spot: 4 of 6,000.
        paceMs: venue === 'binance' ? 600 : 150,
        request: c => ({ url: c && 'fromId' in c ? `${base}&fromId=${c.fromId}` : c && 'start' in c ? `${base}&startTime=${c.start}&endTime=${c.end}` : base }),
        // `m`: the buyer was the maker, so the taker sold.
        parse: body => rows(body, r => trade(r.a, r.m === true ? 'sell' : r.m === false ? 'buy' : null, num(r.p), num(r.q), num(r.T), unit)),
      };
    }
    case 'okx': case 'okxspot': {
      const base = `https://www.okx.com/api/v5/market/history-trades?instId=${sym}&limit=100`, contract = venue === 'okx' ? listing.contract ?? 1 : 1;
      return {
        // 20 requests in 2 s.
        venue, bucket: 'okx-history-trades', mode: 'back', ordered: true, pageRows: 100, paceMs: 150,
        request: c => ({ url: c && 'olderThan' in c ? `${base}&type=1&after=${c.olderThan}` : base }),
        parse: body => { const b = rec(body); return b && b.code === '0' ? rows(b.data, r => trade(r.tradeId, r.side === 'buy' ? 'buy' : r.side === 'sell' ? 'sell' : null, num(r.px), num(r.sz), num(r.ts), unit, contract)) : null; },
      };
    }
    case 'bitget': case 'bitgetspot': {
      const base = venue === 'bitget' ? `https://api.bitget.com/api/v2/mix/market/fills-history?symbol=${sym}&productType=USDT-FUTURES&limit=1000` : `https://api.bitget.com/api/v2/spot/market/fills-history?symbol=${sym}&limit=1000`;
      return {
        // 10 requests a second per endpoint.
        venue, bucket: `bitget-${venue === 'bitget' ? 'mix' : 'spot'}-fills`, mode: 'back', ordered: true, pageRows: 1000, paceMs: 200,
        request: c => ({ url: c && 'olderThan' in c ? `${base}&idLessThan=${c.olderThan}` : base }),
        // `side` is not called the taker's in the documentation; the live answers read as the taker's (Research_Findings.md), as the socket's do.
        parse: body => { const b = rec(body); if (!b || b.code !== '00000') return null; return rows(b.data, r => { const s = String(r.side).toLowerCase(); return trade(r.tradeId, s === 'buy' ? 'buy' : s === 'sell' ? 'sell' : null, num(r.price), num(r.size), num(r.ts), unit); }); },
      };
    }
    case 'coinbase': {
      const base = `https://api.exchange.coinbase.com/products/${sym}/trades?limit=1000`;
      return {
        // 10 requests a second, bursts of 15.
        venue, bucket: 'coinbase', mode: 'back', ordered: true, pageRows: 1000, paceMs: 200,
        request: c => ({ url: c && 'olderThan' in c ? `${base}&after=${c.olderThan}` : base }),
        // `side` is the maker's: a taker bought where it says sell.
        parse: body => rows(body, r => trade(r.trade_id, r.side === 'sell' ? 'buy' : r.side === 'buy' ? 'sell' : null, num(r.price), num(r.size), Date.parse(String(r.time)), unit)),
      };
    }
    case 'bybit': case 'bybitspot': {
      const spot = venue === 'bybitspot', url = `https://api.bybit.com/v5/market/recent-trade?category=${spot ? 'spot' : 'linear'}&symbol=${sym}&limit=${spot ? 60 : 1000}`;
      return {
        // 600 requests in 5 s; one page only (spot's is 60 rows).
        venue, bucket: 'bybit', mode: 'latest', ordered: false, pageRows: spot ? 60 : 1000, paceMs: 200,
        request: () => ({ url }),
        // `seq` names the matching event, as on the socket: the fills of one market order.
        parse: body => { const b = rec(body); return b && b.retCode === 0 ? rows(rec(b.result)?.list, r => trade(r.execId, r.side === 'Buy' ? 'buy' : r.side === 'Sell' ? 'sell' : null, num(r.price), num(r.size), num(r.time), unit, 1, r.seq === undefined || r.seq === null ? undefined : String(r.seq))) : null; },
      };
    }
    case 'hyperliquid': {
      const body = JSON.stringify({ type: 'recentTrades', coin: listing.symbol });
      return {
        // Weight about 20 of 1,200 a minute; ten rows, the newest.
        venue, bucket: 'hyperliquid', mode: 'latest', ordered: false, pageRows: 10, paceMs: 1_000,
        request: () => ({ url: 'https://api.hyperliquid.xyz/info', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body } }),
        // The socket's id: (time, coin, tid) is what the venue calls unique; `hash` names the transaction (the order, or a batch of them).
        parse: answer => rows(answer, r => { const t = num(r.time); return trade(`${t}:${listing.symbol}:${String(r.tid)}`, r.side === 'B' ? 'buy' : r.side === 'A' ? 'sell' : null, num(r.px), num(r.sz), t, unit, 1, r.hash); }),
      };
    }
    default: return null;
  }
}

// ---- One gap --------------------------------------------------------------------------------------------------------------------------

/** One gap of one instrument to recover: [from, to) on the recorder's clock, bounded by the live recording's trades either side (coverage.ts). */
export interface RecoveryJob extends CoverGap { id: string; source: HistorySource; /** The window (bar) it belongs to, by its index in the action. */ window: number }
/**
 * What a gap's pages gave: the rows inside its seam, oldest first, and the stretch they are known to cover whole (`covered`: the gap when the
 * pages reached across it, the part next to the seam they started from when the budget stopped them, null when none). A row on the edge of a
 * part the pages did not finish is left out, since others at its millisecond may be on the page not read.
 */
export interface RecoveryResult { job: RecoveryJob; rows: HistoryTrade[]; covered: [number, number] | null; complete: boolean; pages: number; error?: string }

/** Whether a row is older than the gap (by id where they rise with time, else by time), or newer than it. */
const below = (job: RecoveryJob, r: HistoryTrade): boolean => job.before && job.source.ordered && isWhole(r.tradeId) && isWhole(job.before.id) ? compareIds(r.tradeId, job.before.id) <= 0
  : job.before ? r.t < job.before.t || (r.t === job.before.t && r.tradeId === job.before.id) : r.t < job.from;
const above = (job: RecoveryJob, r: HistoryTrade): boolean => job.after && job.source.ordered && isWhole(r.tradeId) && isWhole(job.after.id) ? compareIds(r.tradeId, job.after.id) >= 0
  : job.after ? r.t > job.after.t || r.tradeId === job.after.id : r.t >= job.to;

/** Rows in exchange-time order, ties by id where ids rise with time. */
export function chronological(list: readonly HistoryTrade[], ordered: boolean): HistoryTrade[] {
  return [...list].sort((a, b) => a.t - b.t || (ordered && isWhole(a.tradeId) && isWhole(b.tradeId) ? compareIds(a.tradeId, b.tradeId) : 0));
}

// ---- The budget ---------------------------------------------------------------------------------------------------------------------

/** One recovery action's ceiling: pages read, rows read, ms from its start, requests in flight at once. */
export interface RecoveryBudget { pages: number; rows: number; ms: number; inflight: number }
export const RECOVERY_BUDGET: Readonly<RecoveryBudget> = Object.freeze({ pages: 20, rows: 20_000, ms: 30_000, inflight: 2 });
/** No request waits longer than this for its answer. */
const REQUEST_MS = 10_000;

/** A venue's answer: its status and parsed body (null when it was not JSON). Rejects when the request did not complete. */
export type HistoryFetch = (request: PageRequest, signal: AbortSignal) => Promise<{ ok: boolean; status: number; body: unknown }>;
export const webHistoryFetch: HistoryFetch = async (request, signal) => {
  const response = await fetch(request.url, { ...request.init, signal, cache: 'no-store' });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
};

export interface RecoveryRun {
  results: RecoveryResult[]; pages: number; rows: number; ms: number;
  /** What ended it: every gap was read, or one of the budget's limits. */
  stoppedBy: 'done' | 'pages' | 'rows' | 'time';
  /** The limits (`HistorySource.bucket`) whose venue answered with an error or not at all: nothing more was asked under them in this action. */
  failed: string[];
}

/**
 * Read the gaps' pages within the budget: `inflight` gaps at a time in the order given (the most wanted first), each limit paced, a limit
 * whose venue fails asked nothing more. `onResult` is told each gap as it ends, so its rows can be applied at once (and atomically, with its stretch).
 */
export async function runRecovery(jobs: readonly RecoveryJob[], fetcher: HistoryFetch, options: { budget?: RecoveryBudget; now?: () => number; sleep?: (ms: number) => Promise<void>; onResult?: (result: RecoveryResult) => void } = {}): Promise<RecoveryRun> {
  const budget = options.budget ?? RECOVERY_BUDGET, now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const start = now(), paced = new Map<string, number>(), failed = new Set<string>(), results: RecoveryResult[] = [];
  let pages = 0, rowsRead = 0, stoppedBy: RecoveryRun['stoppedBy'] = 'done', next = 0;
  /** What the budget no longer allows: another page (one of `pageRows` rows would pass the row ceiling), or any more time. */
  const spent = (pageRows = 1): RecoveryRun['stoppedBy'] | null => pages >= budget.pages ? 'pages' : rowsRead + pageRows > budget.rows ? 'rows' : now() - start >= budget.ms ? 'time' : null;

  /** One page of `job` at `cursor`, paced; null when the budget is spent or the venue failed. */
  const page = async (job: RecoveryJob, cursor: Cursor): Promise<HistoryTrade[] | null> => {
    const venue = job.source.bucket;
    // The limit's turn: the next free slot is taken before waiting, so two gaps under one limit never ask at once.
    const at = Math.max(now(), paced.get(venue) ?? 0); paced.set(venue, at + job.source.paceMs);
    if (at > now()) await sleep(at - now());
    const over = spent(job.source.pageRows); if (over) { if (stoppedBy === 'done') stoppedBy = over; return null; }
    if (failed.has(venue)) return null;
    pages++;
    try {
      const answer = await fetcher(job.source.request(cursor), AbortSignal.timeout(Math.max(1, Math.min(REQUEST_MS, budget.ms - (now() - start)))));
      const list = answer.ok ? job.source.parse(answer.body) : null;
      if (!list) { failed.add(venue); return null; }
      rowsRead += list.length;
      return list;
    } catch {
      // A request cut short because the action's time ran out says nothing against the venue; one that failed or timed out on its own does.
      if (now() - start < budget.ms) failed.add(venue); else if (stoppedBy === 'done') stoppedBy = 'time';
      return null;
    }
  };

  const recover = async (job: RecoveryJob): Promise<RecoveryResult> => {
    const kept = new Map<string, HistoryTrade>(), src = job.source;
    let cursor: Cursor, count = 0, complete = false, edge: number | null = null;
    if (src.mode === 'forward') cursor = job.before && isWhole(job.before.id) ? { fromId: nextId(job.before.id) } : { start: job.from, end: Math.min(job.from + HOUR - 1, job.to) };
    else cursor = src.mode === 'back' && job.after && src.ordered && isWhole(job.after.id) ? { olderThan: job.after.id } : null;
    for (;;) {
      const list = await page(job, cursor);
      if (!list) break;
      count++;
      if (src.mode === 'forward') {
        // Oldest first: on until a row is past the gap, or the newest trade has been read.
        let past = false, last: HistoryTrade | null = null;
        for (const r of list) { if (above(job, r)) { past = true; break; } if (!below(job, r)) kept.set(r.tradeId, r); if (!last || compareIds(r.tradeId, last.tradeId) > 0) last = r; }
        if (past) { complete = true; break; }
        if (list.length >= src.pageRows && last) { cursor = { fromId: nextId(last.tradeId) }; edge = last.t; continue; }
        if (cursor && 'start' in cursor && cursor.end < job.to) { cursor = { start: cursor.end + 1, end: Math.min(cursor.end + HOUR, job.to) }; edge = cursor.start; continue; }
        complete = true; break;
      }
      // Newest first (a back page, or the one latest page): on until a row is older than the gap.
      let reached = false, oldest: HistoryTrade | null = null;
      for (const r of list) { if (below(job, r)) { reached = true; continue; } if (!oldest || r.t < oldest.t) oldest = r; if (!above(job, r)) kept.set(r.tradeId, r); }
      if (reached || !list.length) { complete = true; break; }
      edge = oldest?.t ?? edge;
      if (src.mode === 'latest' || !oldest) break;
      cursor = { olderThan: list.reduce((a, r) => compareIds(r.tradeId, a) < 0 ? r.tradeId : a, list[0]!.tradeId) };
    }
    let covered: [number, number] | null = null, keep = [...kept.values()];
    if (complete) covered = [job.from, job.to];
    else if (edge !== null && src.mode === 'forward') { covered = edge > job.from ? [job.from, edge] : null; keep = keep.filter(r => r.t < edge!); }
    else if (edge !== null) { covered = edge + 1 < job.to ? [Math.max(job.from, edge + 1), job.to] : null; keep = keep.filter(r => r.t > edge!); }
    else keep = [];
    return { job, rows: chronological(keep, src.ordered), covered, complete, pages: count, ...(failed.has(src.bucket) ? { error: 'the venue did not answer' } : {}) };
  };

  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      if (spent()) { if (stoppedBy === 'done') stoppedBy = spent()!; break; }
      const result = await recover(job);
      results.push(result); options.onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, budget.inflight) }, worker));
  return { results, pages, rows: rowsRead, ms: now() - start, stoppedBy, failed: [...failed] };
}

// ---- Planning -----------------------------------------------------------------------------------------------------------------------

/** How many requests a venue's gap of a few minutes takes, roughly: the one-page venues first, then the full pages, OKX's hundred rows last. */
const costClass = (s: HistorySource): number => s.mode === 'latest' ? 0 : s.pageRows >= 1000 ? 1 : 2;

/**
 * The gaps of an action in the order they are read: window by window (the bar under way, then the one before), and in each the instruments
 * as given for the first (the chart market) and then by how cheaply their venue pages (so more markets end up fully covered within the
 * budget), each instrument's gaps newest first.
 */
export function planRecovery(windows: readonly { from: number; to: number }[], instruments: readonly { id: string; source: HistorySource }[], gapsOf: (id: string, from: number, to: number) => CoverGap[]): RecoveryJob[] {
  const [first, ...rest] = instruments;
  const order = first ? [first, ...rest.map((x, i) => ({ x, i })).sort((a, b) => costClass(a.x.source) - costClass(b.x.source) || a.i - b.i).map(({ x }) => x)] : [];
  const jobs: RecoveryJob[] = [];
  windows.forEach((w, window) => { for (const { id, source } of order) for (const gap of gapsOf(id, w.from, w.to).reverse()) jobs.push({ ...gap, id, source, window }); });
  return jobs;
}

/**
 * The gaps with the minutes the recorder holds from storage but has no record of covering taken out (`unknown`: recorded before the coverage
 * record was kept, or by a build without it): their trades are held and not known by id any more, so recovering them would count them
 * twice. A gap cut there is bounded by time at the cut.
 */
export function trimUnknown(gaps: readonly CoverGap[], unknown: (minute: number) => boolean): CoverGap[] {
  const out: CoverGap[] = [];
  for (const g of gaps) {
    const skip: [number, number][] = [];
    for (let t = Math.floor(g.from / MINUTE) * MINUTE; t < g.to; t += MINUTE) if (unknown(t)) skip.push([t, t + MINUTE]);
    if (!skip.length) { out.push(g); continue; }
    for (const [a, b] of complement(skip, g.from, g.to)) out.push({ from: a, to: b, before: a === g.from ? g.before : null, after: b === g.to ? g.after : null });
  }
  return out;
}

/** Market orders rebuilt from recovered fills (oldest first): a builder of their own, closing an order when the next fill is another's. */
export function rebuildOrders(id: string, list: readonly HistoryTrade[]): MarketOrder[] {
  const builder = new OrderBuilder(() => 0, Infinity);
  builder.add(list.map(r => ({ instrumentId: id, tradeId: r.tradeId, side: r.side, price: r.price, notionalUsd: r.notionalUsd, sourceTimestamp: r.t, ...(r.order ? { order: r.order } : {}) })));
  return builder.drain(true);
}

// ---- Into the recordings --------------------------------------------------------------------------------------------------------------

/** What a recovery fills: the browser engine's recorders and the server's are the same ones. */
export interface RecoveryRecordings {
  footprints: Pick<FootprintRecorder, 'ingest' | 'countOrders' | 'holds'>;
  flows: Pick<FlowRecorder, 'ingest'>;
  prints: Pick<PrintStream, 'ingest'>;
  coverage: TradeCoverage;
}

/**
 * The gaps of `id` over [from, to) a recovery may fill: up to where its open stretch reaches (the moment since is the loop's beat, not a
 * gap), and without the minutes the recorder holds from storage with no record of covering (`trimUnknown`; `loadedThrough`, the end of the
 * newest minute it read from storage for `id`): an older build recorded them, and their trades would count twice.
 */
export function recoverableGaps(recordings: Pick<RecoveryRecordings, 'coverage' | 'footprints'>, id: string, from: number, to: number, loadedThrough: number): CoverGap[] {
  const { coverage, footprints } = recordings, open = coverage.openTo(id), end = open !== null && open > from ? Math.min(to, open) : to;
  // The stretches merged once (a server's week holds hundreds), reaching a minute past the window so its edge minutes are judged whole.
  const merged = coverage.covered(id, from - MINUTE, end + MINUTE);
  // Uncovered: the first merged stretch ending after the minute begins starts after it ends (found by halving: asked of every minute of a week).
  const unknown = (t: number): boolean => {
    if (!(t < loadedThrough && footprints.holds(id, t))) return false;
    const at = firstEndingAfter(merged, t);
    return at === merged.length || merged[at]![0] >= t + MINUTE;
  };
  return trimUnknown(coverage.gaps(id, from, end), unknown);
}

/**
 * One gap's recovered trades into the recordings, in one step with the stretch they cover: the footprint takes those it does not hold
 * already (by trade id: the seam's last guard), the flow the same ones, their market orders (rebuilt from them alone) go to the size
 * statistics and the large orders without being handed on as new. Never the live trade path: not the price, the candle, the trade dust,
 * the live order builder or absorption. Returns how many trades were taken.
 */
export function applyRecovered(recordings: RecoveryRecordings, result: RecoveryResult): number {
  const id = result.job.id, taken: HistoryTrade[] = [], byId = new Map(result.rows.map(r => [r.tradeId, r]));
  const rows = result.rows.map(r => ({ instrumentId: id, tradeId: r.tradeId, side: r.side, price: r.price, notionalUsd: r.notionalUsd, sourceTimestamp: r.t }));
  const accepted: typeof rows = [];
  recordings.footprints.ingest(rows, row => { const r = byId.get(String(row.tradeId)); if (r) { taken.push(r); accepted.push(row as (typeof rows)[number]); } }, { recovered: true });
  recordings.flows.ingest(accepted, { recovered: true });
  const orders = rebuildOrders(id, taken);
  recordings.footprints.countOrders(orders);
  recordings.prints.ingest(orders.map(orderRow), false);
  if (result.covered) {
    const first = result.rows[0], last = result.rows[result.rows.length - 1];
    recordings.coverage.recovered(id, result.covered[0], result.covered[1], first ? { id: first.tradeId, t: first.t } : undefined, last ? { id: last.tradeId, t: last.t } : undefined);
  }
  return taken.length;
}
