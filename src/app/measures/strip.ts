import { askedSpan } from '../hub.ts';
import type { AppState, CandleRow, OiBar } from '../store.ts';
import type { InfoLine } from '../infobox.ts';
import type { Liquidation } from '../liquidations.ts';
import type { AbsorptionMark } from '../absorption.ts';
import type { OiPart } from '../oi-change.ts';
import { ensureDeltaFlow, type FlowLoader } from '../delta/flows.ts';
import { flowIds, flowLoadIds, mapVenues } from '../cvd/ids.ts';
import { tradedHeader, tradedNet, tradedNetLine } from '../traded.ts';
import { metricHeader, type MetricFlags, type ProfileMetric } from '../traded/metrics.ts';
import { oiInstrument } from '../../shared/oi-profile.ts';
import { MAX_PROFILE_INSTRUMENTS } from '../../shared/footprint.ts';
import { MAX_ABSORPTION_INSTRUMENTS } from '../../shared/absorption.ts';
import { LIQUIDATIONS_PER_ANSWER } from '../../shared/liquidations.ts';
import { clock, startOfDay } from '../format.ts';
import { t } from '../i18n.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { bandCaption, bucketAt, bucketFor, eventRows, flowRows, minuteFlowAt, oiRows, oiSteps, readingSpacing, stripBand, timeLevels, timeLines, type BucketLimit, type TimeEvent, type TimeLevels, type TimeRows } from './model.ts';
import { paintBand, type BandFrame } from './paint.ts';

/**
 * What the band needs of the hub: the flow and its loaders, a market's open interest by the minute, the source's liquidations (as the
 * liquidation column asks for them), and the absorption marks held.
 */
export interface BandHub extends FlowLoader {
  oiSeries(id: string, tf: string, from: number, to: number): Promise<{ bars: OiBar[]; usdAt?: number }>;
  readonly source: { liquidations?(from: number, to: number): Promise<Liquidation[]> };
  readonly absorption: {
    marks(ids: readonly string[], thresholds: ReadonlyMap<string, number | null>, t0: number, t1: number, p0: number, p1: number): AbsorptionMark[];
    readonly version: number; readonly cover: { readonly from: number; readonly to: number } | null;
  };
  readonly absorptionCut: ReadonlyMap<string, number>;
  readonly absorptionState: 'ready' | 'unavailable' | 'failed';
}

/** The absorption marks' thresholds by instrument (heat-pane.ts `#absorptionContext`). */
export interface AbsorptionContext { thresholds: ReadonlyMap<string, number | null> }

/** What the map hands the band each frame: what the painter needs, where to place it, and what it adds up over. */
export interface TopPlace extends BandFrame {
  /** The bottom of the legend plate (CSS px from the top of the map). */
  legendBottom: number;
  /** The bottom of the map's corner buttons (Go to, Select, Recenter); 0 where there are none (a phone). Read only while the band shows. */
  toolsBottom: () => number;
  /** The stretch the columns add up (heat-pane.ts `#tradedWindow`): what is on the chart, its whole minutes up to the one that is open. */
  window: { from: number; to: number };
  /** The absorption marks' thresholds, read only while the band shows absorption. */
  absorption: () => AbsorptionContext;
  /** Something the band asked for has come: draw again. */
  loaded: () => void;
}

/** Whether the profile along the top shows: it is part of the Volume profile, so its switch counts only while the Volume profile is on. */
export const topShown = (state: Pick<AppState, 'show' | 'traded'>): boolean => state.show.traded && state.traded.top.on;
/** Whether the band shows absorption: the marks' groups must then be loaded for the window, whether the marks show or not. */
export const topAbsorption = (state: Pick<AppState, 'show' | 'traded'>): boolean => topShown(state) && state.traded.top.metric === 'absorption';

/** One measure added up by time for a window, and what it was worked out from. */
interface Worked {
  key: string; refs: readonly unknown[]; metric: ProfileMetric; rows: TimeRows; limit: BucketLimit;
  /** Where the record is cut (the column's flags), how often open interest is read. */
  flags: MetricFlags; spacingMs: number;
  /** Where the numbers begin when that is after the chart's left edge: a source answers eight days at most, as the columns say (`askedSpan`). */
  since: number | null;
  /** The source cannot answer for this measure (an older server). */
  unavailable: boolean;
}

const MINUTE = 60_000;

/**
 * One question at a time for what the band reads by time and the page does not hold, as the columns ask theirs (`Hub.ensureTraded`): again
 * when it changes, and while it reaches the present at most every five seconds, twenty times what the last answer took, five minutes at the
 * longest; a question that only slid with the live edge waits for that spacing. The last answer is kept, and drawn, while the next comes.
 */
class Asked<T> {
  held: T | null = null;
  /** Bumped with each answer, so what was worked out from the last one is known to be stale. */
  version = 0;
  failed = false;
  #asked: { base: string; from: number; to: number; at: number } | null = null;
  #loading = false; #ms = 0; #retryAt = 0;

  ensure(base: string, from: number, to: number, live: boolean, load: () => Promise<T>, loaded: () => void): void {
    const now = Date.now(), spacing = Math.min(300_000, Math.max(5_000, 20 * this.#ms)), a = this.#asked;
    if (this.#loading || now < this.#retryAt) return;
    const same = a !== null && a.base === base && a.from === from && a.to === to;
    const slid = live && a !== null && a.base === base && from >= a.from && to >= a.to && from - a.from <= spacing && to - a.to <= spacing;
    if ((same || slid) && !(live && now - a!.at >= spacing)) return;
    this.#loading = true; this.#asked = { base, from, to, at: now };
    const started = performance.now();
    load().then(value => { this.#ms = performance.now() - started; this.held = value; this.failed = false; this.version++; loaded(); },
      () => { this.failed = true; this.#asked = null; this.#retryAt = Date.now() + 60_000; this.version++; loaded(); })
      .finally(() => { this.#loading = false; });
  }
}

/**
 * The volume profile along the top of the map: the column's measure added up by time over the stretch the column adds up, on the same
 * markets, at the same thresholds (measures/model.ts), drawn under the legend (measures/paint.ts). Nothing is worked out or asked for while
 * it does not show. A frame that only moves the pointer reuses what was worked out: it is kept until the measure, the buckets, the window's
 * whole seconds or what it is read from change.
 */
export class TopProfile {
  #worked: Worked | null = null;
  #ids: { key: readonly unknown[]; ids: string[] } | null = null;
  /** Open interest by the minute of the column's perpetuals, whatever the chart's timeframe, so a candle's ups and downs are not netted. */
  readonly #oi = new Asked<{ ids: string; parts: OiPart[] }>();
  /** The liquidations the column adds up: every one the source holds over the window, its largest `LIQUIDATIONS_PER_ANSWER` when more. */
  readonly #liquidations = new Asked<Liquidation[]>();
  /** The band, the rows and the levels drawn last (for the pointer), and the legend bottom the band was placed under. */
  #drawn: { band: { top: number; height: number }; headW: number; worked: Worked; levels: TimeLevels | null } | null = null;
  #placedFor: number | null = null;

  /** Draw the band for this frame, or nothing while it does not show (it then also works nothing out and asks for nothing). */
  paint(ctx: CanvasRenderingContext2D, state: AppState, hub: BandHub, f: TopPlace): void {
    this.#drawn = null;
    if (!topShown(state)) { this.#placedFor = null; this.#worked = null; return; }
    this.#placedFor = f.legendBottom;
    const band = stripBand({ legendBottom: f.legendBottom, toolsBottom: f.toolsBottom(), ph: f.ph, volume: state.show.volume });
    if (!band || !(f.view.t1 > f.view.t0)) return;
    const now = pageNow(), worked = this.work(state, hub, f.window, f.view.t1 - f.view.t0, f.pw, now, f.absorption, f.loaded);
    if (!worked) return;
    const rows = worked.rows, s = state.traded, levels = s.valueArea ? timeLevels(rows, s.share / 100) : null;
    // The pointer over the band frames its bucket, as a row of the column is framed.
    const hv = state.hover, y = hv && hv.source === 'heat' && hv.price !== null ? f.view.yOf(hv.price, f.ph) : NaN;
    const hovered = hv && y >= band.top && y <= band.top + band.height ? bucketAt(rows, hv.t) : -1;
    const headW = paintBand(ctx, rows, band, f, { bars: s.bars, emphasis: s.emphasis, levels, ...this.#header(worked), caption: bandCaption(rows.step, worked.limit, worked.metric, worked.spacingMs), hovered, now });
    this.#drawn = { band, headW, worked, levels };
  }

  /** The column's header for these rows: traded volume's, or another measure's, with what its record leaves out. */
  #header(w: Worked): { head: string; sub: string; warn: boolean; net: { text: string; sign: number } | null } {
    const rows = w.rows, net = rows.total > 0 ? { text: tradedNetLine(rows), sign: Math.sign(tradedNet(rows)) } : null;
    const measured = w.metric === 'volume' ? null : metricHeader(w.metric, rows, w.flags);
    const [head, sub, warn] = measured ? [measured.head, measured.sub, measured.warn] : [...tradedHeader(rows), rows.partial];
    if (w.unavailable && !(rows.total > 0)) return { head, sub: t('not on this server'), warn: false, net: null };
    // A chart wider than a source answers: its newest part, said as the column says it.
    if (w.since !== null) return { head, sub: t('since {time}', { time: clock(w.since, w.since < startOfDay(Date.now())) }), warn: true, net };
    return { head, sub, warn, net };
  }

  /**
   * Whether the band was placed under another legend than the one this frame drew: the legend is drawn last, over everything, so the band
   * is placed under the last frame's, and a legend that grew or shrank asks for one more frame.
   */
  misplaced(legendBottom: number): boolean { return this.#placedFor !== null && this.#placedFor !== legendBottom; }

  /** Whether a point of the map is on the band's header, which opens the profile's settings (the Volume profile panel at its time profile). */
  onHeader(x: number, y: number): boolean { const d = this.#drawn; return !!d && x >= 0 && x <= d.headW && y >= d.band.top && y <= d.band.top + d.band.height; }

  /** The box for the bucket under the pointer when it is over the band, off its header (`x`, `y` on the map, `t` its time), and where it opens; null elsewhere. */
  readout(x: number, y: number, time: number): { lines: InfoLine[]; y: number } | null {
    const d = this.#drawn;
    if (!d || y < d.band.top || y > d.band.top + d.band.height) return null;
    // The header is a button (it opens the settings): nothing is read out over it, not even the map under it.
    if (x <= d.headW) return { lines: [], y: d.band.top + d.band.height };
    const i = bucketAt(d.worked.rows, time);
    if (i < 0) return null;
    return { lines: timeLines(d.worked.rows, i, { metric: d.worked.metric, spacingMs: d.worked.spacingMs, levels: d.levels, now: pageNow() }), y: d.band.top + d.band.height };
  }

  /**
   * The measure by time over the columns' window (up to now, its newest eight days at most, as a source answers the columns) in buckets
   * about as thick as the column's rows at this zoom: kept while nothing it depends on changed, the bucket under way worked out again at
   * most once a second. The markets are the columns' (`flowIds`), each measure narrowed as its column narrows them.
   */
  work(state: AppState, hub: BandHub, win: { from: number; to: number }, span: number, pw: number, now: number, absorption: () => AbsorptionContext, loaded: () => void = () => {}): Worked | null {
    const metric = state.traded.top.metric, { from, to } = askedSpan(win.from, Math.min(win.to, now));
    if (!(to > from) || !(span > 0)) return null;
    const since = from > win.from + MINUTE ? from : null, second = Math.floor(to / 1000), ids = this.#flowIds(state, hub), live = state.followLive && !replaying();
    const done = (key: string, refs: readonly unknown[], rows: TimeRows, limit: BucketLimit, extra: Partial<Worked> = {}): Worked =>
      this.#worked = { key, refs, metric, rows, limit, flags: { cut: false, incomplete: false }, spacingMs: 0, since, unavailable: false, ...extra };
    if (metric === 'volume') {
      const tracks = ids.flatMap(id => { const k = hub.flow.track(id); return k ? [k] : []; });
      const { step, limit } = bucketFor(span, pw, minuteFlowAt(tracks, from) ? MINUTE : 0);
      const key = `v|${step}|${from}|${second}|${ids.join(',')}|${hub.flow.loads}`;
      if (this.#worked?.key === key) return this.#worked;
      ensureDeltaFlow(hub, flowLoadIds(state, hub.flow.ids), from, Date.now());
      return done(key, [], flowRows(tracks, from, to, step, now), limit);
    }
    if (metric === 'oi') {
      // The column's perpetuals, read by the minute from ten minutes before the window, so its first reading has one before it.
      const oiIds = ids.filter(oiInstrument).slice(0, MAX_PROFILE_INSTRUMENTS), base = oiIds.join(','), askFrom = Math.floor((from - 10 * MINUTE) / MINUTE) * MINUTE, askTo = Math.ceil(to / MINUTE) * MINUTE + MINUTE;
      this.#oi.ensure(base, askFrom, askTo, live, async () => ({ ids: base, parts: (await Promise.all(oiIds.map(async id => ({ id, ...await hub.oiSeries(id, '1m', askFrom, askTo).catch(() => ({ bars: [] as OiBar[] })) })))).filter(p => p.bars.length) }), loaded);
      const { step, limit } = bucketFor(span, pw, MINUTE);
      const key = `o|${step}|${from}|${second}|${this.#oi.version}`, refs = [state.candles];
      if (this.#worked?.key === key && this.#worked.refs.every((r, i) => r === refs[i])) return this.#worked;
      // Replay: only the minutes that had ended by its moment.
      const held = this.#oi.held, parts = (held?.parts ?? []).map(p => ({ ...p, bars: replaying() ? p.bars.filter(b => b[0] + MINUTE <= now) : p.bars }));
      const steps = oiSteps(parts, MINUTE, priceOf(state.candles));
      return done(key, refs, oiRows(steps, from, to, step), limit, { spacingMs: readingSpacing(parts.map(p => p.bars)) });
    }
    const { step, limit } = bucketFor(span, pw);
    if (metric === 'liquidations') {
      const source = hub.source;
      if (source.liquidations) this.#liquidations.ensure('', from, to, live, () => source.liquidations!(from, to), loaded);
      const key = `l|${step}|${from}|${second}|${ids.join(',')}|${this.#liquidations.version}`;
      if (this.#worked?.key === key) return this.#worked;
      const rows = this.#liquidations.held ?? [], wanted = new Set(ids), events: TimeEvent[] = [];
      // Shorts liquidated are forced buys (bid colour), longs liquidated forced sells (ask colour), as in the column.
      for (const l of rows) if (wanted.has(l.id)) events.push({ t: l.t, side: l.side === 'short' ? 0 : 1, usd: l.usd });
      const held = this.#liquidations.held !== null;
      return done(key, [], eventRows(events, from, to, step, held ? { from: -Infinity, to: Infinity } : null), limit,
        { flags: { cut: rows.length >= LIQUIDATIONS_PER_ANSWER, incomplete: false }, unavailable: !source.liquidations || (this.#liquidations.failed && !held) });
    }
    // Absorption: the marks' groups at the marks' thresholds, each its marked part, on the instruments the column judges.
    const { thresholds } = absorption(), book = hub.absorption;
    const judged = ids.filter(id => typeof thresholds.get(id) === 'number').slice(0, MAX_ABSORPTION_INSTRUMENTS);
    const key = `a|${step}|${from}|${second}|${judged.join(',')}|${book.version}|${hub.absorptionState}`, refs = [thresholds];
    if (this.#worked?.key === key && this.#worked.refs.every((r, i) => r === refs[i])) return this.#worked;
    // Market sells resting buyers took first (bid colour), then market buys resting sellers took (ask colour).
    const events = book.marks(judged, thresholds, from, to, -Infinity, Infinity).map((m): TimeEvent => ({ t: m.t0, side: m.side === 'sell' ? 0 : 1, usd: m.usd }));
    const cut = judged.some(id => { const least = hub.absorptionCut.get(id), threshold = thresholds.get(id); return least !== undefined && threshold !== null && threshold !== undefined && least >= threshold; });
    return done(key, refs, eventRows(events, from, to, step, book.cover), limit, { flags: { cut, incomplete: false }, unavailable: hub.absorptionState === 'unavailable' });
  }

  /** The columns' markets (`flowIds`), worked out again only when what they depend on changes (as the footprint's markets are). */
  #flowIds(state: AppState, hub: FlowLoader): string[] {
    const onMap = mapVenues(state), key = [state.markets, state.disabledVenues, state.scope, onMap ? [...onMap].sort().join(',') : null, hub.flow.ids.length, hub.flow.loads];
    if (!this.#ids || this.#ids.key.some((k, i) => k !== key[i])) this.#ids = { key, ids: flowIds(state, hub.flow.ids) };
    return this.#ids.ids;
  }
}

const prices = new WeakMap<readonly CandleRow[], (t: number) => number | undefined>();
/**
 * The price a change of open interest at `t` is put in dollars at: the close of the chart's candle holding it, or of the nearest candle where
 * none does (the OI pane puts its changes at its candles' closes too). None without candles.
 */
function priceOf(candles: readonly CandleRow[]): (t: number) => number | undefined {
  let f = prices.get(candles);
  if (f) return f;
  f = (at: number): number | undefined => {
    if (!candles.length) return undefined;
    let lo = 0, hi = candles.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid]![0] <= at) lo = mid + 1; else hi = mid; }
    return candles[Math.max(0, lo - 1)]![4];
  };
  prices.set(candles, f);
  return f;
}
