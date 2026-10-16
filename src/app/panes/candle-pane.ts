import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { AppState, CandleRow, Store } from '../store.ts';
import type { Kernels } from '../kernels.ts';
import { FootprintData, imbalance, volText, type Bar } from './footprint.ts';
import { groupLevels, type Grouped } from './levels-data.ts';
import { barPieces, rankVenues } from './ladder-pieces.ts';
import { setText } from './lower-panes.ts';
import { activeIds } from '../scope.ts';
import { PALETTES, mixHex, resolveThemeId, rgb, textOn, type Palette } from '../theme.ts';
import { t } from '../i18n.ts';
import { helpButton } from '../help.ts';
import { el } from '../dom.ts';
import { GestureRecognizer, bindTouch } from '../touch.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { price as fmtPrice } from '../format.ts';
import { scaledUsd } from '../coin.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { niceStep } from '../view.ts';
import { STRIDE, type TapeRing } from '../tape/ring.ts';
import { TrailGL, type FlashSprite } from '../candle/trail-gl.ts';
import * as M from '../candle/model.ts';
import type { CoverageAnswer } from '../../shared/coverage.ts';
import type { RecoveryReport } from '../../shared/engine.ts';

const NUM_FONT = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
const SMALL_FONT = '10px ui-sans-serif, system-ui, sans-serif';
/** How long an arrival keeps its tick on the rail (ms), after its flash has gone. */
const RAIL_MS = 2_500;
/** The fewest ms between two drawings of the book and candle (the price ticks many times a second). */
const PAINT_MS = 50;
/** The most exchange marks in the trail at once (its newest whale-sized orders). */
const MAX_TRAIL_MARKS = 10;
/** How often the candle's own bars are asked for again; between answers the price moves the forming one. */
const CANDLES_MS = 15_000;
/** How often the markets' coverage is asked for again while the view shows (and at once after a recovery). */
const COVERAGE_MS = 3_000;
/** How long after the view opens, or the page comes back, a recovery starts: the feeds reconnect first, and the gap ends where they do. */
const RECOVER_OPEN_MS = 800, RECOVER_RETURN_MS = 1_500;

/** The forming bar as drawn: open, high, low and close. */
interface Ohlc { t: number; o: number; h: number; l: number; c: number }

/**
 * The phone's Candle view (a tab of its own, see dock.ts): the candle under way for the view's own timeframe filling the screen's price
 * axis, its footprint inside it, the live book on both sides, the price line, the arrival rail where large orders flash as they come in,
 * and behind all of it the trade trail of the last seconds (candle/trail-gl.ts) flowing from the rail to the left edge. Every column and
 * scale is worked out in candle/model.ts.
 *
 * What it reads is what the page already holds: the tape ring of the trade dust (asked for while this view is shown), the footprint of the
 * markets the map's footprint counts (its own FootprintData, one bar), the live levels frame, and the chart market's bars of the view's
 * timeframe. It does nothing while it is not shown: no drawing, no requests, no timers.
 *
 * Venues: the small orders stay anonymous dots; an order from the Bar stats' whale size up carries its exchange's mark beside it in the
 * trail, fading with it, and the largest flashes on the rail show the mark of the exchange that sent them for a moment. They are drawn on
 * a canvas of their own between the trail and the book, at the trail's pace, so the book and the candle are not redrawn for them.
 *
 * Coverage (shared/coverage.ts): the footprint counts every market the map's footprint counts, but judges (the imbalance colours, the point
 * of control) only over the markets whose trades were recorded without a break since the bar opened, live or recovered (`coveredMarkets`).
 * The other markets' part of each row is drawn on, faint and neutral, and the header says how many of the markets are fully covered. On
 * open and on return from the background the view asks the source to recover the bar's missing trades from the venues' history, then the
 * bar before (shared/recovery.ts); recovered trades never flash or sound (the rail and the trail are the live trade dust's alone).
 */
export class CandlePane {
  readonly root = el('div', { class: 'pane candle' });
  readonly header: HTMLElement;
  #body = el('div', { class: 'candle-body' });
  #trailCanvas = el('canvas', { class: 'candle-trail' });
  #marks = el('canvas', { class: 'candle-marks' });
  #canvas = el('canvas', { class: 'candle-fg' });
  #ctx: CanvasRenderingContext2D; #marksCtx: CanvasRenderingContext2D;
  /** The glass's rectangle as the candle was last drawn (CSS px), for the trail's frosted part. */
  #glassRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  #trail: TrailGL | null = null; #trailFailed = false; #trailRing: TapeRing | null = null;
  #readout = el('span', { class: 'readout' });
  #settings: M.CandleSettings;
  #fp = new FootprintData();
  #candles: CandleRow[] = []; #candleKey = ''; #candleAt = 0; #candleBusy = false;
  /** The extremes the price reached in the forming bar between answers, so a high is not lost until the next one. */
  #live: Ohlc | null = null;
  #palette: Palette = PALETTES.dark!;
  #w = 0; #h = 0; #dpr = 1;
  #shown = false; #frame = 0; #paintTimer = 0; #lastPaint = 0; #trailTimer = 0; #trailRaf = 0; #trailChain = 0; #trailDue = 0; #tick = 0;
  #zoom = 1; #zoom0 = 1; #pan = 0;
  #layout: M.CandleLayout | null = null; #scale: M.PriceScale | null = null; #step = 0;
  /** The book's venues in a held order (most liquidity in view first), kept for a minute so a venue's piece keeps its place. */
  #order: { key: string; ids: string[]; at: number } | null = null;
  #maskKey = '';
  #reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /** The markets' trade coverage over the bar and the one before (null: none yet, or a source that cannot say), what it was asked for, and when. */
  #coverage: CoverageAnswer | null = null; #coverageKey = ''; #coverageAt = 0; #coverageBusy = false;
  /** A recovery from the venues' history: due (its timer), under way, and asked for again while under way. */
  #recoverTimer = 0; #recovering = false; #recoverAgain = false;
  /** What the last recovery did (pages, rows, what stopped it, each market's gaps and what of them was filled), for a look from the console. */
  lastRecovery: RecoveryReport | null = null;

  constructor(parent: HTMLElement, private store: Store, private hub: Hub, private kernels: Kernels, private markets: (state: AppState) => string[]) {
    let saved: unknown = null;
    try { saved = JSON.parse(window.localStorage.getItem(M.CANDLE_SETTINGS_KEY) ?? 'null'); } catch { saved = null; }
    this.#settings = M.readCandleSettings(saved);
    const s = this.#settings;
    const select = (label: string, options: [string, string][], value: string, change: (v: string) => void): HTMLLabelElement => {
      const box = el('select', { onchange: () => change(box.value) });
      for (const [v, text] of options) box.append(el('option', { value: v, textContent: text }));
      box.value = value;
      return el('label', { class: 'ctl' }, label, box);
    };
    this.header = el('div', { class: 'pane-head' },
      el('strong', { textContent: t('Candle') }),
      select(t('Timeframe'), M.CANDLE_TIMEFRAMES.map(tf => [tf, tf]), s.tf, v => this.#set({ tf: v })),
      select(t('Look'), [['phosphor', t('Phosphor')], ['etched', t('Etched')], ['beads', t('Beads')]], s.style, v => this.#set({ style: v as M.TrailStyle })),
      select(t('Trail'), M.TRAIL_WINDOWS.map(ms => [String(ms), ms < 60_000 ? t('{n} s', { n: ms / 1000 }) : t('{n} min', { n: ms / 60_000 })]), String(s.trailMs), v => this.#set({ trailMs: Number(v) })),
      (() => { const box = el('input', { type: 'checkbox', checked: s.glass, onchange: () => this.#set({ glass: box.checked }) }); return el('label', { class: 'ctl' }, box, t('Glass')); })(),
      helpButton('candlePane'),
      this.#readout);
    this.#body.append(this.#trailCanvas, this.#marks, this.#canvas);
    this.root.append(this.header, this.#body);
    parent.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!; this.#marksCtx = this.#marks.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#body);
    this.#bindGestures();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !this.#shown) return;
      // Back from the background (a phone suspends the page): what the recording missed meanwhile is asked of the venues' history.
      this.#refreshCandles(true); this.#refreshCoverage(true); this.invalidate(); this.#scheduleTrail(0); this.#scheduleRecovery(RECOVER_RETURN_MS);
    });
  }

  #set(patch: Partial<M.CandleSettings>): void {
    const next = M.readCandleSettings({ ...this.#settings, ...patch });
    const tfChanged = next.tf !== this.#settings.tf;
    this.#settings = next;
    try { window.localStorage.setItem(M.CANDLE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    if (tfChanged) { this.#candles = []; this.#live = null; this.#candleKey = ''; this.#refreshCandles(true); this.#refreshCoverage(true); this.#scheduleRecovery(RECOVER_OPEN_MS); }
    this.invalidate(); this.#scheduleTrail(0);
  }

  setPalette(name: string): void { this.#palette = PALETTES[resolveThemeId(name)] ?? PALETTES.dark!; this.invalidate(); this.#scheduleTrail(0); }

  /** Shown or not (the phone's tab is this view's): only a shown view draws, asks or keeps a timer. */
  setShown(on: boolean): void {
    if (on === this.#shown) return;
    this.#shown = on;
    if (on) {
      this.#resize(); this.#refreshCandles(true); this.#refreshCoverage(true); this.invalidate(); this.#scheduleTrail(0); this.#scheduleRecovery(RECOVER_OPEN_MS);
      // The countdown and the bars' and coverage's refresh; a page that is not shown asks for nothing (it draws nothing either: no frames come).
      this.#tick = window.setInterval(() => { if (document.hidden) return; this.#refreshCandles(false); this.#refreshCoverage(false); this.#writeReadout(); }, 1_000);
    } else {
      window.clearInterval(this.#tick); this.#tick = 0; window.clearTimeout(this.#recoverTimer); this.#recoverTimer = 0;
      this.#cancelTrail(); window.clearTimeout(this.#paintTimer); this.#paintTimer = 0;
      if (this.#frame) { cancelAnimationFrame(this.#frame); this.#frame = 0; }
    }
  }
  get shown(): boolean { return this.#shown; }

  /** A gap of a market was filled from its venue's history: the bar's coverage and rows are asked for again when the market is one of the view's. */
  recovered(id: string, from: number): void {
    if (!this.#shown || !this.markets(this.store.state).includes(id)) return;
    this.#fp.refresh(from); this.#refreshCoverage(true); this.invalidate();
  }

  /** The market changed: its bars and its forming candle are another market's (and the markets counted may be others). */
  marketChanged(): void {
    this.#candles = []; this.#live = null; this.#candleKey = ''; this.#zoom = 1; this.#pan = 0; this.#coverage = null;
    if (this.#shown) { this.#refreshCandles(true); this.#refreshCoverage(true); this.#scheduleRecovery(RECOVER_OPEN_MS); }
    this.invalidate();
  }

  /** The markets' trade coverage over the bar under way and the one before, asked again every COVERAGE_MS (or now). */
  #refreshCoverage(force: boolean): void {
    const source = this.hub.source, state = this.store.state, markets = this.markets(state);
    if (!this.#shown || !source.coverage || !markets.length || replaying()) { if (!source.coverage) this.#coverage = null; return; }
    const tfMs = TIMEFRAMES[this.#settings.tf] ?? 300_000, now = this.hub.sourceNow(), barT = Math.floor(now / tfMs) * tfMs, key = `${markets.join(',')}|${barT}`;
    if (this.#coverageBusy || (!force && key === this.#coverageKey && performance.now() - this.#coverageAt < COVERAGE_MS)) return;
    this.#coverageBusy = true;
    source.coverage(markets, 'trades', barT - tfMs, now + 1).then(answer => {
      this.#coverage = answer; this.#coverageKey = key; this.invalidate();
    }, () => { this.#coverage = null; this.#coverageKey = key; }).finally(() => { this.#coverageBusy = false; this.#coverageAt = performance.now(); });
  }

  /** A recovery in `delay` ms (one due at a time: a page that flaps between shown and hidden asks once). */
  #scheduleRecovery(delay: number): void {
    if (!this.hub.source.recover) return;
    window.clearTimeout(this.#recoverTimer);
    this.#recoverTimer = window.setTimeout(() => { this.#recoverTimer = 0; void this.#recover(); }, delay);
  }

  /**
   * Ask the source to fill the bar's missing trades from the venues' history, then the bar before's: the chart market first, then the others
   * the view counts. One at a time; asked again while one runs, it runs once more after.
   */
  async #recover(): Promise<void> {
    const recover = this.hub.source.recover?.bind(this.hub.source), state = this.store.state, markets = this.markets(state);
    if (!recover || !this.#shown || document.hidden || replaying() || !markets.length) return;
    if (this.#recovering) { this.#recoverAgain = true; return; }
    const tfMs = TIMEFRAMES[this.#settings.tf] ?? 300_000, now = this.hub.sourceNow(), barT = Math.floor(now / tfMs) * tfMs;
    const ids = markets.includes(state.marketId) ? [state.marketId, ...markets.filter(id => id !== state.marketId)] : markets;
    this.#recovering = true; this.#writeReadout();
    try { this.lastRecovery = await recover({ ids, windows: [{ from: barT, to: now }, { from: barT - tfMs, to: barT }] }); }
    catch (error) { console.warn('the trades the recording missed could not be recovered:', error); }
    finally {
      this.#recovering = false; this.#fp.refresh(barT - tfMs); this.#refreshCoverage(true); this.invalidate(); this.#writeReadout();
      if (this.#recoverAgain) { this.#recoverAgain = false; this.#scheduleRecovery(RECOVER_OPEN_MS); }
    }
  }

  /** Orders arrived for the trail: drawn on the next trail frame, and the rail's ticks with the book. */
  tapeArrived(): void { if (!this.#shown) return; this.#scheduleTrail(0); this.invalidate(); }

  invalidate(): void {
    if (!this.#shown || this.#frame || this.#paintTimer) return;
    const wait = PAINT_MS - (performance.now() - this.#lastPaint);
    if (wait > 0) this.#paintTimer = window.setTimeout(() => { this.#paintTimer = 0; this.invalidate(); }, wait);
    else this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#paint(); });
  }

  #resize(): void {
    const rect = this.#body.getBoundingClientRect();
    this.#w = Math.floor(rect.width); this.#h = Math.floor(rect.height);
    // Text is crisp at two device pixels to a CSS pixel; the trail's glow gains nothing past one and a half.
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#canvas.width = Math.max(1, Math.round(this.#w * this.#dpr)); this.#canvas.height = Math.max(1, Math.round(this.#h * this.#dpr));
    this.#canvas.style.width = `${this.#w}px`; this.#canvas.style.height = `${this.#h}px`;
    this.#marks.width = this.#canvas.width; this.#marks.height = this.#canvas.height; this.#marks.style.width = this.#canvas.style.width; this.#marks.style.height = this.#canvas.style.height;
    this.#trail?.resize(this.#w, this.#h, Math.min(this.#dpr, 1.5));
    this.invalidate(); this.#scheduleTrail(0);
  }

  #bindGestures(): void {
    const panBy = (dy: number): void => {
      const s = this.#scale; if (!s) return;
      const span = s.p1 - s.p0;
      this.#pan = Math.max(-span * 0.45, Math.min(span * 0.45, this.#pan + dy * span / (s.y1 - s.y0)));
      this.invalidate(); this.#scheduleTrail(0);
    };
    const zoomTo = (z: number): void => { this.#zoom = Math.max(0.2, Math.min(8, z)); this.invalidate(); this.#scheduleTrail(0); };
    const reset = (): void => { this.#zoom = 1; this.#pan = 0; this.invalidate(); this.#scheduleTrail(0); };
    bindTouch(this.#canvas, new GestureRecognizer({
      pinchStart: () => { this.#zoom0 = this.#zoom; },
      // Fingers moving apart show fewer prices: the span shrinks as the vertical separation grows.
      pinch: info => { if (info.start.dy > 24 && info.now.dy > 24) zoomTo(this.#zoom0 * info.start.dy / info.now.dy); },
      pan: delta => panBy(delta.y),
      doubleTap: reset,
    }));
    // A mouse (a narrow desktop window gets the phone's arrangement): the wheel zooms, a drag moves, a double click resets.
    this.#canvas.addEventListener('wheel', e => { e.preventDefault(); zoomTo(this.#zoom * Math.exp(e.deltaY * 0.0015)); }, { passive: false });
    this.#canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      let last = e.clientY;
      const move = (m: PointerEvent): void => { panBy(m.clientY - last); last = m.clientY; };
      const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    this.#canvas.addEventListener('dblclick', reset);
  }

  /** The chart market's bars of the view's timeframe, asked again every CANDLES_MS (or now, after a change). */
  #refreshCandles(force: boolean): void {
    const state = this.store.state, tf = this.#settings.tf, tfMs = TIMEFRAMES[tf] ?? 300_000, key = `${state.marketId}|${tf}`;
    if (!this.#shown || !state.marketId || this.#candleBusy) return;
    if (!force && key === this.#candleKey && performance.now() - this.#candleAt < CANDLES_MS) return;
    this.#candleBusy = true;
    const now = Date.now();
    this.hub.source.candles(state.marketId, tf, now - 4 * tfMs, now + tfMs).then(rows => {
      if (key !== `${this.store.state.marketId}|${this.#settings.tf}`) return;
      this.#candles = rows; this.#candleKey = key; this.#candleAt = performance.now(); this.invalidate();
    }, () => { this.#candleAt = performance.now(); }).finally(() => { this.#candleBusy = false; });
  }

  /** The forming bar: the venue's bar when it has one, moved by the price since, its extremes kept between answers. */
  #forming(barT: number, mark: number): Ohlc | null {
    const row = this.#candles.find(r => r[0] === barT), before = [...this.#candles].reverse().find(r => r[0] < barT);
    const live = this.#live && this.#live.t === barT ? this.#live : null;
    const open = row?.[1] ?? live?.o ?? before?.[4] ?? (mark > 0 ? mark : 0);
    if (!(open > 0)) return null;
    let h = Math.max(row?.[2] ?? open, live?.h ?? open), l = Math.min(row?.[3] ?? open, live?.l ?? open);
    const c = mark > 0 ? mark : row?.[4] ?? open;
    h = Math.max(h, c); l = Math.min(l, c);
    this.#live = { t: barT, o: open, h, l, c };
    return this.#live;
  }

  #paint(): void {
    this.#lastPaint = performance.now();
    const w = this.#w, h = this.#h, ctx = this.#ctx, p = this.#palette, state = this.store.state;
    if (!this.#shown || w < 120 || h < 120) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const l = M.candleLayout(w, h); this.#layout = l;
    if (replaying()) { this.#scale = null; this.#message(ctx, l, t('The Candle view shows the live market only.')); return; }
    const tf = this.#settings.tf, tfMs = TIMEFRAMES[tf] ?? 300_000, now = pageNow(), barT = Math.floor(now / tfMs) * tfMs;
    const mark = state.mark.price, bar = this.#forming(barT, mark);
    if (!bar) { this.#scale = null; this.#message(ctx, l, t('Waiting for the market…')); return; }
    const fpBar = this.#fp.bars.get(barT), fpStep = this.#fp.step;
    let lo = bar.l, hi = bar.h;
    if (fpBar && fpStep > 0) for (const r of fpBar.rows) if (r[1] + r[2] > 0) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[0] + fpStep); }
    const scale = M.priceSpan(lo, hi, mark, l.plotY0, l.plotY1, this.#zoom, this.#pan); this.#scale = scale;
    // The footprint of the bar (and the one before it): the markets the map's footprint counts, on rows tall enough to read.
    const markets = this.markets(state);
    if (markets.length) this.#fp.ensure(markets.join(','), tf, { t0: barT, t1: now, p0: scale.p0, p1: scale.p1 }, M.rowStepFor(this.#fp.fine, scale), (inst, tf2, from, to, rows, lines, budget, venues) => this.hub.footprint(inst, tf2, from, to, rows, lines, budget, venues), () => this.invalidate(), [], this.hub.sourceNow());
    else this.#fp.clear();
    const step = fpStep > 0 ? fpStep : niceStep(scale.p1 - scale.p0, (scale.y1 - scale.y0) / 18); this.#step = step;
    // Judged over the markets recorded without a break since the bar opened, by the coverage record (none until it answers).
    const covered = M.coveredMarkets(this.#coverage, markets, barT);
    this.#paintRuler(ctx, l, p);
    ctx.save(); ctx.beginPath(); ctx.rect(0, l.plotY0, l.axisX0, l.plotY1 - l.plotY0); ctx.clip();
    this.#paintBook(ctx, l, scale, step, mark, state, p);
    this.#paintCandle(ctx, l, scale, bar, fpBar, fpStep, covered, markets, p);
    this.#paintRail(ctx, l, scale, step, p);
    ctx.restore();
    this.#paintAxis(ctx, l, scale, mark, bar, p);
    this.#writeReadout(covered.size, markets.length);
    this.#scheduleTrail(0);
  }

  #message(ctx: CanvasRenderingContext2D, l: M.CandleLayout, text: string): void {
    ctx.fillStyle = this.#palette.muted; ctx.font = '13px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, l.w / 2, l.h / 2);
    this.#trail?.clear();
  }

  /** What the header last said: how many of the markets counted are fully covered (none is said before the bar has been looked at). */
  #lastCovered = 0; #lastMarkets = 0;
  #writeReadout(covered = this.#lastCovered, markets = this.#lastMarkets): void {
    this.#lastCovered = covered; this.#lastMarkets = markets;
    if (!this.#shown) return;
    const tf = this.#settings.tf, tfMs = TIMEFRAMES[tf] ?? 300_000, now = pageNow(), left = Math.floor(now / tfMs) * tfMs + tfMs - now;
    const parts = [tf, t('closes in {time}', { time: M.countdownText(left) }), t('{n} selected · {m} fully covered', { n: markets, m: covered })];
    if (this.#recovering) parts.push(t('recovering earlier trades…'));
    setText(this.#readout, parts.join(' · '));
  }

  /** The age ruler under the trail: now at the rail, then every quarter of the window. */
  #paintRuler(ctx: CanvasRenderingContext2D, l: M.CandleLayout, p: Palette): void {
    const y = l.plotY1 + 4;
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l.trailX0, y + 0.5); ctx.lineTo(l.trailX1, y + 0.5); ctx.stroke();
    ctx.font = SMALL_FONT; ctx.fillStyle = p.muted; ctx.textBaseline = 'top';
    for (const tick of M.ageTicks(this.#settings.trailMs)) {
      const x = M.trailX(l, tick.ms, this.#settings.trailMs);
      ctx.fillRect(Math.round(x) - 0.5, y, 1, 4);
      ctx.textAlign = tick.ms === 0 ? 'right' : tick.ms >= this.#settings.trailMs ? 'left' : 'center';
      ctx.fillText(tick.seconds === 0 ? t('now') : t('{n} s', { n: tick.seconds }), Math.max(2, Math.min(l.trailX1, x)), y + 5);
    }
  }

  /** The venues in their held order: re-ranked once a minute or when the set changes. */
  #venueOrder(g: Grouped): string[] {
    const key = [...g.ids].sort().join(','), now = performance.now();
    if (this.#order && this.#order.key === key && now - this.#order.at < 60_000) return this.#order.ids;
    const sum = new Map(g.ids.map((id, k) => { let s = 0; for (let i = 0; i < g.nBins; i++) s += g.bid[k]![i]! + g.ask[k]![i]!; return [id, s] as const; }));
    const ids = rankVenues(g.ids, id => sum.get(id) ?? 0);
    this.#order = { key, ids, at: now };
    return ids;
  }

  /** The live book on the rows of the footprint: asks above the price growing right of the candle, bids below growing left, in venue pieces. */
  #paintBook(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, step: number, mark: number, state: AppState, p: Palette): void {
    const frame = state.levels; if (!frame || !(mark > 0) || !(step > 0)) return;
    const g = groupLevels(this.kernels, frame, activeIds(state), step, s.p0, s.p1);
    if (!g.ids.length) return;
    const order = this.#venueOrder(g), at = order.map(id => g.ids.indexOf(id)), markBin = Math.floor(mark / step);
    let max = 0;
    const top: { side: 'bid' | 'ask'; i: number; usd: number }[] = [];
    for (let i = 0; i < g.nBins; i++) {
      const bin = g.bin0 + i, y = M.yOf(s, (bin + 0.5) * step); if (y < s.y0 || y > s.y1) continue;
      if (bin >= markBin) { max = Math.max(max, g.totalAsk[i]!); top.push({ side: 'ask', i, usd: g.totalAsk[i]! }); }
      if (bin <= markBin) { max = Math.max(max, g.totalBid[i]!); top.push({ side: 'bid', i, usd: g.totalBid[i]! }); }
    }
    if (!(max > 0)) return;
    // The book is the setting, the candle the subject: each side a silhouette, a faint fill in venue pieces under a crisp outer edge, so
    // the trail behind it stays readable and the shape of the book reads at a glance.
    const sideW = l.bidX1 - l.bidX0, rowPx = step * (s.y1 - s.y0) / (s.p1 - s.p0);
    for (const side of ['ask', 'bid'] as const) {
      const color = side === 'ask' ? p.ask : p.bid, edge: { y0: number; y1: number; w: number }[] = [];
      for (let i = 0; i < g.nBins; i++) {
        const bin = g.bin0 + i; if (side === 'ask' ? bin < markBin : bin > markBin) continue;
        const y0 = M.yOf(s, (bin + 1) * step), y1 = y0 + rowPx; if (y1 < s.y0 || y0 > s.y1) continue;
        const total = side === 'ask' ? g.totalAsk[i]! : g.totalBid[i]!;
        edge.push({ y0, y1, w: total / max * sideW });
        if (!(total > 0)) continue;
        const values = at.map(k => (side === 'ask' ? g.ask[k]! : g.bid[k]!)[i] ?? 0);
        ctx.fillStyle = color;
        for (const piece of barPieces(order, values, max, 0, sideW, 2)) {
          ctx.globalAlpha = piece.rank < 0 ? 0.07 : (p.dark ? (piece.rank % 2 ? 0.13 : 0.21) : (piece.rank % 2 ? 0.1 : 0.17));
          const x = side === 'ask' ? l.askX0 + piece.x : l.bidX1 - piece.x - piece.w;
          ctx.fillRect(x, y0, Math.max(0.5, piece.w), rowPx);
        }
      }
      if (!edge.length) continue;
      edge.sort((a, b) => a.y0 - b.y0);
      const xOf = (w: number): number => side === 'ask' ? l.askX0 + w : l.bidX1 - w, inner = xOf(0);
      ctx.globalAlpha = p.dark ? 0.9 : 0.8; ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.lineJoin = 'miter';
      ctx.beginPath(); ctx.moveTo(inner, edge[0]!.y0);
      for (const e of edge) { ctx.lineTo(xOf(e.w), e.y0); ctx.lineTo(xOf(e.w), e.y1); }
      ctx.lineTo(inner, edge[edge.length - 1]!.y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // The two largest levels each side say their size, at the bar's outer end.
    ctx.font = SMALL_FONT; ctx.textBaseline = 'middle'; ctx.fillStyle = p.text;
    for (const side of ['ask', 'bid'] as const) {
      for (const lvl of top.filter(x => x.side === side && x.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 2)) {
        const y = M.yOf(s, (g.bin0 + lvl.i + 0.5) * step), w = lvl.usd / max * sideW, label = volText(lvl.usd), tw = ctx.measureText(label).width;
        const x = side === 'ask' ? Math.min(l.askX0 + w + 4, l.askX1 - tw) : Math.max(l.bidX1 - w - 4 - tw, l.bidX0);
        ctx.globalAlpha = 0.72; ctx.fillStyle = p.bg; ctx.fillRect(x - 2, y - 6.5, tw + 4, 13);
        ctx.globalAlpha = 1; ctx.fillStyle = p.text; ctx.textAlign = 'left'; ctx.fillText(label, x, y);
      }
    }
  }

  /**
   * The hollow candle with its footprint inside: sells left of the middle, buys right. Each row's bar is what every market counted traded
   * there; its inner part, the fully covered markets', carries the judgement (the side's colour where it traded 1.15 times the other) and
   * the point of control is theirs, while the outer part, the markets covered in part, is faint and neutral. With no market fully covered
   * nothing is judged.
   */
  #paintCandle(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, bar: Ohlc, fpBar: Bar | undefined, step: number, covered: ReadonlySet<string>, markets: readonly string[], p: Palette): void {
    const x0 = l.candleX0, x1 = l.candleX1, split = (x0 + x1) / 2, half = (x1 - x0) / 2 - 2, up = bar.c >= bar.o, col = up ? p.candleUp : p.candleDown;
    const judged = covered.size > 0, whole = judged && markets.every(id => covered.has(id));
    const rows = fpBar && step > 0 ? fpBar.rows.flatMap((r, i) => r[1] + r[2] > 0 ? [{ r, split: M.splitRow(r[1], r[2], fpBar.parts?.[i], covered, markets) }] : []) : [];
    let top = bar.h, bottom = bar.l;
    for (const { r } of rows) { top = Math.max(top, r[0] + step); bottom = Math.min(bottom, r[0]); }
    // The candle's column is a panel of its own: the trail passes behind it, never through its numbers. Solid, it hides the trail; glass,
    // the trail shows through it frosted (trail-gl.ts) under a tint dense enough for the numbers, with a lit edge and a darker one.
    const yTop = M.yOf(s, top) - 3, yBottom = M.yOf(s, bottom) + 3, glass = this.#settings.glass;
    this.#glassRect = glass ? { x0, y0: Math.max(s.y0, yTop), x1, y1: Math.min(s.y1, yBottom) } : null;
    ctx.fillStyle = p.panel; ctx.globalAlpha = glass ? (p.dark ? 0.42 : 0.5) : 1; ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop); ctx.globalAlpha = 1;
    const bodyTop = M.yOf(s, Math.max(bar.o, bar.c)), bodyBottom = Math.max(bodyTop + 1.5, M.yOf(s, Math.min(bar.o, bar.c)));
    // The body is the denser part of the glass: on a light page nearly opaque ink (lighter would turn a muddy grey), on a dark one a tint.
    const bodyFill = p.dark ? mixHex(p.panel, p.text, 0.07) : mixHex(p.text, p.panel, 0.04), bodyAlpha = glass ? (p.dark ? 0.72 : 0.94) : 1;
    const bodyShown = mixHex(p.bg, bodyFill, bodyAlpha);
    ctx.fillStyle = bodyFill; ctx.globalAlpha = bodyAlpha; ctx.fillRect(x0, bodyTop, x1 - x0, bodyBottom - bodyTop); ctx.globalAlpha = 1;
    if (glass) {
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = p.dark ? 0.16 : 0.7; ctx.fillRect(x0, yTop, 1, yBottom - yTop); ctx.fillRect(x0, yTop, x1 - x0, 1);
      ctx.fillStyle = '#000000'; ctx.globalAlpha = p.dark ? 0.45 : 0.12; ctx.fillRect(x1 - 1, yTop, 1, yBottom - yTop); ctx.fillRect(x0, yBottom - 1, x1 - x0, 1);
      ctx.globalAlpha = 1;
    }
    // A bar some market was not recorded for whole: its range with no rows is hatched, not left empty, so "not recorded" never reads as "nothing traded".
    if (!whole) {
      const seen = rows.length ? { hi: M.yOf(s, Math.max(...rows.map(x => x.r[0])) + step), lo: M.yOf(s, Math.min(...rows.map(x => x.r[0]))) } : null;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, yTop, x1 - x0, yBottom - yTop);
      if (seen) ctx.rect(x1, seen.hi, x0 - x1, seen.lo - seen.hi);
      ctx.clip('evenodd');
      ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.16; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = x0 - (yBottom - yTop); x < x1; x += 7) { ctx.moveTo(x, yBottom); ctx.lineTo(x + (yBottom - yTop), yTop); }
      ctx.stroke(); ctx.restore(); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.moveTo(split, M.yOf(s, bar.h)); ctx.lineTo(split, bodyTop); ctx.moveTo(split, bodyBottom); ctx.lineTo(split, M.yOf(s, bar.l)); ctx.stroke();
    ctx.strokeRect(x0 + 0.75, bodyTop, x1 - x0 - 1.5, bodyBottom - bodyTop);
    if (rows.length) {
      const rowPx = step * (s.y1 - s.y0) / (s.p1 - s.p0), rh = Math.max(1, rowPx - (rowPx > 4 ? 1 : 0));
      let busiest = 0; for (const { r } of rows) busiest = Math.max(busiest, r[1], r[2]);
      // The point of control of the covered markets alone (none when no market is).
      const poc = judged ? M.pocIndex(rows.map(({ r, split: c }) => [r[0], c.buy, c.sell] as const)) : -1;
      ctx.font = NUM_FONT; ctx.textBaseline = 'middle';
      rows.forEach(({ r: [low, buy, sell], split: c }, i) => {
        const y = M.yOf(s, low + step); if (y + rh < s.y0 || y > s.y1) return;
        const inBody = y + rh / 2 >= bodyTop && y + rh / 2 <= bodyBottom, side = judged ? imbalance(c.buy, c.sell) : null;
        // The bar's length is what every market traded; its inner part the covered markets', in proportion, the rest outside it.
        const sw = Math.sqrt(sell / busiest) * half, bw = Math.sqrt(buy / busiest) * half;
        const swIn = sell > 0 ? sw * c.sell / sell : 0, bwIn = buy > 0 ? bw * c.buy / buy : 0;
        ctx.globalAlpha = side === 'sell' ? 0.95 : side === 'buy' ? 0.38 : 0.5; ctx.fillStyle = p.candleDown; ctx.fillRect(split - 1 - swIn, y, swIn, rh);
        ctx.globalAlpha = side === 'buy' ? 0.95 : side === 'sell' ? 0.38 : 0.5; ctx.fillStyle = p.candleUp; ctx.fillRect(split + 1, y, bwIn, rh);
        ctx.globalAlpha = p.dark ? 0.2 : 0.16; ctx.fillStyle = p.muted;
        if (sw > swIn) ctx.fillRect(split - 1 - sw, y, sw - swIn, rh);
        if (bw > bwIn) ctx.fillRect(split + 1 + bwIn, y, bw - bwIn, rh);
        ctx.globalAlpha = 1;
        if (rh >= 11) {
          // A small row's numbers are the ink faded, not the muted grey: on the dark body grey would barely read.
          const small = buy + sell < busiest * 0.04, ink = inBody ? textOn(bodyShown, 1, p) : p.text;
          ctx.fillStyle = ink; ctx.globalAlpha = small ? 0.55 : 1;
          ctx.textAlign = 'right'; if (sell >= 1) ctx.fillText(volText(sell), split - 4, y + rh / 2);
          ctx.textAlign = 'left'; if (buy >= 1) ctx.fillText(volText(buy), split + 4, y + rh / 2);
          ctx.globalAlpha = 1;
        }
        if (i === poc) { ctx.strokeStyle = p.poc; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, y + 0.25, x1 - x0 - 1.5, rh - 0.5); }
      });
    }
  }

  /** The orders of the ring that arrived at or after `since` (the page's clock), inside the view's markets. */
  #arrivals(ring: TapeRing, since: number, hidden: ReadonlySet<number>): M.Arrival[] {
    const out: M.Arrival[] = [];
    for (const a of ring.arrivals) {
      if (a.at < since) continue;
      for (let k = Math.max(a.from, ring.first); k < a.to; k++) {
        const at = (k % ring.capacity) * STRIDE, d = ring.data;
        if (hidden.has(d[at + 3]!)) continue;
        out.push({ price: ring.p0 + d[at + 1]!, usd: d[at + 2]!, at: a.at, inst: d[at + 3]! });
      }
    }
    return out;
  }

  /** The ring's markets outside the view's (the map's footprint markets; none chosen, as in the footprint, counts none). */
  #hidden(ring: TapeRing): Set<number> {
    const want = new Set(this.markets(this.store.state));
    return new Set(ring.ids.flatMap((id, i) => want.has(id) ? [] : [i]));
  }

  /** The rail's ticks: each row that received orders in the last RAIL_MS, its sold and bought share, fading. */
  #paintRail(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, step: number, p: Palette): void {
    ctx.fillStyle = p.line; ctx.fillRect(l.railX0, s.y0, 1, s.y1 - s.y0);
    const ring = this.hub.tape; if (!ring || !(step > 0)) return;
    const now = performance.now(), cells = M.railCells(this.#arrivals(ring, now - RAIL_MS, this.#hidden(ring)), step, now - RAIL_MS, now);
    const x0 = l.railX0 + 19, w = l.railX1 - l.railX0 - 21;
    for (const c of cells) {
      const y = M.yOf(s, (c.bin + 0.5) * step); if (y < s.y0 || y > s.y1) continue;
      const fade = 1 - (now - c.at) / RAIL_MS, sold = c.sell / (c.buy + c.sell);
      ctx.globalAlpha = 0.25 + 0.6 * fade;
      ctx.fillStyle = p.candleDown; ctx.fillRect(x0, y - 1.5, w * sold, 3);
      ctx.fillStyle = p.candleUp; ctx.fillRect(x0 + w * sold, y - 1.5, w * (1 - sold), 3);
    }
    ctx.globalAlpha = 1;
  }

  /** Prices down the right edge, the price line across everything, and its tag. */
  #paintAxis(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, mark: number, bar: Ohlc, p: Palette): void {
    const pStep = niceStep(s.p1 - s.p0, Math.max(3, (s.y1 - s.y0) / 56));
    ctx.font = SMALL_FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const markY = mark > 0 ? M.yOf(s, mark) : -100;
    for (let q = Math.ceil(s.p0 / pStep) * pStep; q <= s.p1; q += pStep) {
      const y = M.yOf(s, q); if (y < s.y0 + 6 || y > s.y1 - 6 || Math.abs(y - markY) < 12) continue;
      ctx.fillText(fmtPrice(q, pStep), l.axisX1 - 4, y);
    }
    if (!(mark > 0)) return;
    const col = bar.c >= bar.o ? p.candleUp : p.candleDown;
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(0, Math.round(markY) + 0.5); ctx.lineTo(l.axisX0, Math.round(markY) + 0.5); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.fillRect(l.axisX0 + 1, markY - 8, l.axisX1 - l.axisX0 - 1, 16);
    ctx.fillStyle = textOn(col, 1, p); ctx.font = `600 ${SMALL_FONT}`;
    ctx.fillText(fmtPrice(mark, this.#step > 0 ? Math.min(this.#step, pStep) : pStep), l.axisX1 - 4, markY);
  }

  /**
   * The exchanges' marks: beside each order of the trail from the whale size up (the newest MAX_TRAIL_MARKS), fading with the trail, and
   * left of the rail's largest flashes while they last and a moment after (FLASH_MARK_MS).
   */
  #drawMarks(ring: TapeRing, l: M.CandleLayout, s: M.PriceScale, now: number, page: number, hidden: ReadonlySet<number>, reduced: boolean): void {
    const ctx = this.#marksCtx, step = this.#step;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0); ctx.clearRect(0, 0, this.#w, this.#h);
    const whale = scaledUsd(this.store.state.barStatOptions.whaleUsd), win = this.#settings.trailMs;
    const big: { x: number; y: number; id: string; a: number }[] = [];
    for (const [a, b] of ring.runs(now - win, now + 2_000)) {
      for (let k = a; k < b; k++) {
        const at = (k % ring.capacity) * STRIDE, d = ring.data, usd = Math.abs(d[at + 2]!);
        if (usd < whale || hidden.has(d[at + 3]!)) continue;
        const age = now - (ring.t0 + d[at]!); if (age > win || age < -1_500) continue;
        big.push({ x: M.trailX(l, age, win), y: M.yOf(s, ring.p0 + d[at + 1]!), id: ring.ids[d[at + 3]!] ?? '', a: Math.max(0.25, (1 - age / win) ** 1.2) });
      }
    }
    for (const m of big.slice(-MAX_TRAIL_MARKS)) {
      if (m.y < s.y0 || m.y > s.y1 || !m.id) continue;
      ctx.globalAlpha = m.a; drawVenueMark(ctx, m.id, m.x - 9, m.y - 9, 10);
    }
    if (!reduced && step > 0) {
      // The marks of the largest flashes, from the large arrivals alone (a later small order must not keep one up or move it).
      const markUsd = scaledUsd(100_000);
      const cells = M.railCells(this.#arrivals(ring, page - M.FLASH_MARK_MS, hidden).filter(o => Math.abs(o.usd) >= markUsd), step, page - M.FLASH_MARK_MS, page)
        .sort((a, b) => b.largest - a.largest).slice(0, 3);
      for (const c of cells) {
        const y = M.yOf(s, (c.bin + 0.5) * step), id = ring.ids[c.largestInst]; if (!id || y < s.y0 || y > s.y1) continue;
        ctx.globalAlpha = Math.max(0, 1 - (page - c.at) / M.FLASH_MARK_MS); drawVenueMark(ctx, id, l.railX0 - 8, y, 11);
      }
    }
    ctx.globalAlpha = 1;
  }

  #ensureTrail(ring: TapeRing): TrailGL | null {
    if (this.#trail && this.#trailRing === ring) return this.#trail;
    if (this.#trailFailed) return null;
    try { this.#trail = new TrailGL(this.#trailCanvas, ring); this.#trailRing = ring; this.#maskKey = ''; this.#trail.resize(this.#w, this.#h, Math.min(this.#dpr, 1.5)); }
    catch (error) { this.#trailFailed = true; console.warn('the trade trail cannot be drawn here:', error); }
    return this.#trail;
  }

  /**
   * The next trail frame in `delay` ms, or sooner when one is already due later (an arrival must not wait out the slow clock: its flash is
   * short). One chain only: the timer or the frame it asked for is cancelled when the view is hidden, and a callback from before is ignored.
   */
  #scheduleTrail(delay: number): void {
    if (!this.#shown) return;
    const due = performance.now() + delay;
    if ((this.#trailTimer || this.#trailRaf) && due >= this.#trailDue) return;
    this.#cancelTrail();
    this.#trailDue = due;
    const chain = this.#trailChain;
    this.#trailTimer = window.setTimeout(() => {
      this.#trailTimer = 0;
      this.#trailRaf = requestAnimationFrame(() => { this.#trailRaf = 0; if (chain === this.#trailChain) this.#drawTrail(); });
    }, delay);
  }
  #cancelTrail(): void {
    window.clearTimeout(this.#trailTimer); this.#trailTimer = 0;
    if (this.#trailRaf) { cancelAnimationFrame(this.#trailRaf); this.#trailRaf = 0; }
    this.#trailChain++;
  }

  /** The trail and the rail's flashes, then the next frame: soon while a flash fades, else when the trail has moved about a pixel. */
  #drawTrail(): void {
    if (!this.#shown || document.hidden) return;
    const ring = this.hub.tape, l = this.#layout, s = this.#scale, p = this.#palette;
    if (!ring || !l || !s || replaying()) { this.#trail?.clear(); return; }
    const trail = this.#ensureTrail(ring); if (!trail) return;
    const hidden = this.#hidden(ring), maskKey = [...hidden].join(',');
    if (maskKey !== this.#maskKey) { trail.setMask([...hidden]); this.#maskKey = maskKey; }
    const reduced = this.#reduced?.matches ?? false, page = performance.now(), step = this.#step;
    // The trail's right edge is the exchange's now: the source's clock, or the newest order when the page's clock runs behind it.
    const sourceNow = this.hub.sourceNow(), newest = ring.written > 0 ? ring.t0 + ring.data[((ring.written - 1) % ring.capacity) * STRIDE]! : 0;
    const now = Math.max(sourceNow, Math.min(newest, sourceNow + 2_000));
    const lo = scaledUsd(25_000), hiUsd = scaledUsd(2_000_000), railX = l.railX0 + 10.5;
    const lit = reduced || !(step > 0) ? [] : M.flashes(this.#arrivals(ring, page - M.FLASH_MS, hidden), step, lo, page);
    const flashes: FlashSprite[] = lit.map(c => ({ x: railX, y: M.yOf(s, (c.bin + 0.5) * step), r: M.flashRadius(c.largest, lo, hiUsd), share: c.buy / (c.buy + c.sell), k: c.k }));
    trail.draw({
      style: this.#settings.style, dark: p.dark, bid: rgb(p.candleUp), ask: rgb(p.candleDown), mid: rgb(p.dark ? '#d8dce4' : '#3a3f48'),
      now, windowMs: this.#settings.trailMs, x0: l.trailX0, x1: l.trailX1, y0: s.y0, y1: s.y1, p0: s.p0, p1: s.p1,
      floorUsd: scaledUsd(100), ceilUsd: scaledUsd(250_000), opacity: p.dark ? 0.8 : 0.85, flashes,
      glass: this.#settings.glass ? this.#glassRect : null,
    });
    this.#drawMarks(ring, l, s, now, page, hidden, reduced);
    const pxMs = this.#settings.trailMs / Math.max(1, l.trailX1 - l.trailX0);
    this.#scheduleTrail(reduced ? 1_000 : flashes.length ? 50 : Math.max(50, Math.min(250, pxMs)));
  }
}
