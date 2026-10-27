import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import type { Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { TimePane, setText } from './lower-panes.ts';
import { ScriptHost, type WorkerLike } from '../script/host.ts';
import { ScriptData } from '../script/data.ts';
import { UNREAD_VENUE, analyze, sourcesWith, type Analysis } from '../script/lang/analysis.ts';
import { ScriptSyntaxError, type ScriptError } from '../script/lang/lexer.ts';
import { SCRIPT_API, loadScripts, storeScripts, type ScriptRecord } from '../script/records.ts';
import { starterScripts } from '../script/starter.ts';
import { PLOT_FIELDS, type ScriptResult, type Warning } from '../script/protocol.ts';
import { paintPlot, scaleIdOf, scalesOf, shortNumber, visibleRange, yOf, type Frame } from '../script/paint.ts';
import { errorText } from '../script/messages.ts';
import { safeColor } from '../script/lang/colors.ts';
import type { SourceFilter } from '../script/inputs.ts';
import type { ScriptsPanelState } from '../script/panel.ts';
import { lazy } from '../lazy.ts';

/** What the pane knows of a script between runs. */
/** A script's last answer, the candles it was worked out over (their starts, timeframe and market): drawn only over those. */
interface Held { result: ScriptResult; time: Float64Array; tf: number; inst: string }

/** How often a script runs at most (ms), and how often it runs again anyway while nothing it reads changes (the candle under way fills in). */
const MIN_INTERVAL = 1_000, REFRESH = 15_000;

/**
 * The Scripts pane: a row for each of the person's scripts that is switched on, each with its own scales, drawn over the map's time axis.
 * The scripts run in a worker of their own (script/script.worker.ts), never on this thread; this pane gathers what they read
 * (script/data.ts), asks for a run at most once a second, and less often when a run takes longer (four times its length apart), so a heavy
 * script cannot keep a core busy. The Scripts… button opens the panel that lists, writes, imports and exports them (script/panel.ts).
 */
export class ScriptPane extends TimePane {
  #records: ScriptRecord[] = loadScripts(undefined, starterScripts);
  #version = 0;
  #host = new ScriptHost({ spawn: () => new Worker(new URL('../script/script.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike });
  #data: ScriptData;
  #analysis = new Map<string, Analysis | ScriptError>();
  /** Each script's last answer; a new map at every run, so what is worked out from it can tell when to work it out again. */
  #held = new Map<string, Held>();
  #warnings = new Map<string, Warning[]>();
  #lastRun = 0; #runMs = 0; #timer = 0; #running = false;
  #seen: { candles: unknown; loads: number; data: number; version: number; tf: string; markets: unknown; venues: unknown; scope: string } | null = null;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #panel: Panel | null = null;
  readonly #ui: ScriptsPanelState = { editing: null, draft: null, message: null, armed: null };
  #button: HTMLButtonElement;

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'script');
    this.#data = new ScriptData(hub, () => this.invalidate());
    this.head.innerHTML = `<strong>${t('Scripts')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('scriptPane'));
    setTip(this.head.querySelector('strong')!, t('Your own indicators, written as scripts over the candles and the taker flow.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    this.#button = document.createElement('button'); this.#button.type = 'button'; this.#button.textContent = t('Scripts…');
    setTip(this.#button, t('Write, switch on and off, import and export your scripts.'));
    this.#button.onclick = () => this.openPanel();
    group.append(this.#button);
  }

  /** The scripts, in their order. */
  get records(): readonly ScriptRecord[] { return this.#records; }
  /** A script's last answer, its warnings, and what reading it found (or why it could not be read). */
  resultOf(id: string): ScriptResult | null { return this.#held.get(id)?.result ?? null; }
  warningsOf(id: string): readonly Warning[] { return this.#warnings.get(id) ?? []; }
  analysisOf(r: ScriptRecord): Analysis | ScriptError { return this.#analyze(r.source); }

  /** Keep an answer made here, as a new map (what is worked out from the answers, the candle colours, is worked out again). */
  #setHeld(id: string, held: Held): void { this.#held = new Map(this.#held).set(id, held); this.#heldGen++; this.onMapChanged(); }

  /** Keep `list` as the scripts; false when this browser refused to store it (the list still applies until the page closes). */
  setRecords(list: ScriptRecord[]): boolean {
    // A script whose text, options or version changed has no answer until it runs again: the old one is not drawn meanwhile.
    const was = new Map(this.#records.map(r => [r.id, r]));
    const stale = list.filter(r => { const o = was.get(r.id); return !o || o.source !== r.source || o.api !== r.api || JSON.stringify(o.options) !== JSON.stringify(r.options) || !r.on; });
    if (stale.some(r => this.#held.has(r.id))) { this.#held = new Map(this.#held); for (const r of stale) this.#held.delete(r.id); this.#heldGen++; this.onMapChanged(); }
    this.#records = list;
    this.#version++;
    for (const id of [...this.#held.keys()]) if (!list.some(r => r.id === id)) this.#held.delete(id);
    const kept = storeScripts(list);
    this.#lastRun = 0;
    this.invalidate();
    return kept;
  }

  /** The panel's code, loaded the first time the panel opens (a page that never opens it does not carry it). */
  #panelCode: typeof import('../script/panel.ts') | null = null;
  readonly #build = (_tools: HTMLElement, body: HTMLElement): void => { this.#panelCode?.buildScriptsPanel(this, body, () => this.#panel?.render(this.#build), this.#ui); };
  openPanel(): void {
    if (!this.#panelCode) { void lazy(() => import('../script/panel.ts')).then(m => { if (m) { this.#panelCode = m; this.openPanel(); } }); return; }
    this.#panel = togglePanel(this.#button, { title: t('Scripts'), width: 520, align: 'right', onClose: () => { this.#panel = null; }, stays: true }, this.#build);
  }
  /** Draw the panel again with the latest results, unless a script is being written there (the text box keeps its place). */
  #refreshPanel(): void { if (this.#panel && !this.#ui.editing) this.#panel.render(this.#build); }

  #analyze(source: string): Analysis | ScriptError {
    let a = this.#analysis.get(source);
    if (!a) {
      try { a = analyze(source); } catch (e) { if (e instanceof ScriptSyntaxError) a = e.info; else throw e; }
      if (this.#analysis.size > 64) this.#analysis.clear();
      this.#analysis.set(source, a);
    }
    return a;
  }

  /** Whether the inputs changed since the last run, and if a run is due, start one. */
  #maybeRun(): void {
    const state = this.store.state;
    const on = this.#records.filter(r => r.on);
    if (!state.show.script || !on.length || this.#running) return;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const seen = { candles: state.candles, loads: this.hub.flow.loads, data: this.#data.version, version: this.#version, tf: state.timeframe, markets: state.markets, venues: state.disabledVenues, scope: state.scope, inst: state.seriesInstrument, replay: replaying() ? Math.floor(pageNow() / tf) : -1 };
    const was = this.#seen, now = Date.now();
    const changed = !was || Object.keys(seen).some(k => (seen as Record<string, unknown>)[k] !== (was as Record<string, unknown>)[k]);
    // Nothing changed: run again at the refresh anyway (the candle under way fills in from the flow), on a timer, so a quiet page still refreshes.
    if (!changed && now - this.#lastRun < REFRESH) { this.#wake(this.#lastRun + REFRESH - now); return; }
    const interval = Math.max(MIN_INTERVAL, this.#runMs * 4), wait = this.#lastRun + interval - now;
    if (wait > 0) { this.#wake(wait); return; }
    this.#seen = seen;
    this.#run(on);
  }

  /** Draw again (and so look whether a run is due) in `ms`. */
  #wakeAt = 0;
  #wake(ms: number): void {
    const at = Date.now() + Math.max(50, ms);
    if (this.#timer && this.#wakeAt <= at) return;
    if (this.#timer) window.clearTimeout(this.#timer);
    this.#wakeAt = at;
    this.#timer = window.setTimeout(() => { this.#timer = 0; this.#wakeAt = 0; this.invalidate(); }, at - Date.now());
  }

  #run(on: readonly ScriptRecord[]): void {
    const state = this.store.state;
    const filters = new Map<string, SourceFilter>([['', {}]]);
    const runnable: ScriptRecord[] = [];
    for (const r of on) {
      if (r.api > SCRIPT_API) { this.#setHeld(r.id, { result: { id: r.id, ok: false, error: { code: 'newer-api', line: 0, col: 0 } }, time: new Float64Array(0), tf: 0, inst: '' }); continue; }
      const a = this.#analyze(r.source);
      if (!('program' in a)) { this.#setHeld(r.id, { result: { id: r.id, ok: false, error: a }, time: new Float64Array(0), tf: 0, inst: '' }); continue; }
      // Its markets as its options name them (`exchange=options.venue`): the worker works them out from the same values.
      for (const [k, f] of sourcesWith(a, r.options)) filters.set(k, f);
      runnable.push(r);
    }
    if (!runnable.length) return;
    const inputs = this.#data.inputs(state, filters);
    if (!inputs) return;
    // What each script reads that the page cannot give it: an option it reads but does not declare that is not set, a set of markets with none.
    const markets = this.#data.markets(state, filters);
    for (const r of runnable) {
      const a = this.#analyze(r.source) as Analysis, w: Warning[] = [];
      for (const name of a.read) if (!(name in r.options)) w.push({ code: 'unset-option', detail: name });
      for (const [k, f] of sourcesWith(a, r.options)) {
        if (f.venues?.includes(UNREAD_VENUE)) w.push({ code: 'unread-source' });
        else if (k && !markets.get(k)?.length) w.push({ code: 'no-markets', detail: k.replace(/;/g, ', ') });
      }
      if (this.#data.liquidationsCut && (a.inputs.has('lbuy') || a.inputs.has('lsell'))) w.push({ code: 'liquidations-cut' });
      this.#warnings.set(r.id, w);
    }
    const time = inputs.time.slice(), tf = inputs.tf, inst = state.seriesInstrument, started = Date.now();
    this.#running = true; this.#lastRun = started;
    const version = this.#version;
    void this.#host.run(runnable.map(r => ({ id: r.id, source: r.source, options: r.options, api: r.api })), inputs).then(results => {
      this.#running = false;
      if (!results.length) return;
      // Scripts changed while it ran (edited, switched off, deleted): its answer is stale, and the next run is due at once.
      if (version !== this.#version) { this.invalidate(); return; }
      // The run's own time (a worker that waited to load, or never did, is not a slow script): a slow script runs less often.
      this.#runMs = this.#host.lastRunMs;
      for (const res of results) this.#held.set(res.id, { result: res, time, tf, inst });
      this.#held = new Map(this.#held); this.#heldGen++;
      this.invalidate();
      this.onMapChanged();
      this.#refreshPanel();
    });
  }

  protected draw(): void {
    this.#maybeRun();
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  #paint(): void {
    const { ctx, palette: p } = this, state = this.store.state, pw = this.plotW, ph = this.h, v = this.view;
    const running = this.#records.filter(r => r.on), on = running.filter(r => r.place === 'pane');
    setText(this.head.querySelector('.readout'), this.#records.length ? tn(running.length, '{n} script on', '{n} scripts on') : '');
    ctx.textBaseline = 'middle';
    if (!on.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(!this.#records.length ? t('No scripts yet: open Scripts… to write one or add an example.') : running.length ? t('The scripts that are on draw on the map.') : t('Every script is switched off: switch one on in Scripts….'), 12, ph / 2);
      return;
    }
    const total = on.reduce((s, r) => s + r.height, 0), least = Math.max(1, Math.min(24, Math.floor(ph / on.length)));
    let top = 0;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const hv = state.hover;
    const card: InfoLine[] = [];
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    on.forEach((r, k) => {
      const left = on.length - 1 - k, rowH = left === 0 ? Math.max(least, ph - top) : Math.max(least, Math.min(ph - top - left * least, Math.round(ph * r.height / total)));
      const held = this.#held.get(r.id);
      if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.w, top + 0.5); ctx.stroke(); }
      // A row's name stands on a faint plate of the page's colour, so a plot under it does not make it hard to read.
      const label = (text: string, color: string, y: number): void => {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
        const w = Math.min(pw - 8, ctx.measureText(text).width + 8);
        ctx.globalAlpha = 0.78; ctx.fillStyle = p.bg; ctx.fillRect(2, y - 7, w, 14); ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.fillText(text, 6, y);
      };
      if (!held) label(`${r.name} · ${t('running…')}`, p.muted, top + 9);
      else if (!held.result.ok) { label(r.name, p.text, top + 9); ctx.save(); ctx.beginPath(); ctx.rect(0, top, pw, rowH); ctx.clip(); label(errorText(held.result.error), p.ask, top + 24); ctx.restore(); }
      else {
        const res = held.result, time = held.time;
        // A run for another timeframe is not drawn over this one: the next run replaces it.
        if (held.tf === tf && held.inst === state.seriesInstrument && time.length) {
          const [from, to] = visibleRange(time, v.t0, v.t1, tf);
          const scales = scalesOf(res.plots, r.options, from, to);
          const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top, height: rowH, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
          res.plots.forEach((plot, j) => {
            const s = scales.get(scaleIdOf(plot, r.options));
            if (s) paintPlot({ ...frame, color: fallbacks[j % fallbacks.length]! }, plot, s);
          });
          // The tags of the row's first scale at its right edge: the highest and the lowest in view.
          const first = scales.values().next().value;
          if (first) {
            ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.fillStyle = p.muted;
            ctx.fillText(shortNumber(first.max), this.w - 4, Math.max(top + 8, yOf(first.max, first, top, rowH)));
            ctx.fillText(shortNumber(first.min), this.w - 4, Math.min(top + rowH - 8, yOf(first.min, first, top, rowH)));
          }
          if (hv) this.#cardLines(card, r, res, time, tf, hv.t);
        }
        const notes = this.warningsOf(r.id).length + res.warnings.length;
        label(notes ? `${r.name} · ${tn(notes, '{n} warning', '{n} warnings')}` : r.name, notes ? p.muted : p.text, top + 9);
      }
      top += rowH;
    });
    if (card.length) this.#lines = card;
  }

  /** Called when what the scripts draw on the map changed (the map draws again). */
  onMapChanged: () => void = () => {};
  #candleColors = new Map<number, string>();
  #colorsKey = '';
  #heldGen = 0;

  /** A script's colour for the map's candle starting at `t` (`$price.color = ...`), or '' for the candle's own. */
  candleColorAt(t: number): string {
    if (!this.store.state.show.script) return '';
    const state = this.store.state, key = `${this.#heldGen}|${this.#version}|${state.timeframe}|${state.seriesInstrument}`;
    if (this.#colorsKey !== key) { this.#colorsKey = key; this.#rebuildColors(); }
    return this.#candleColors.get(t) ?? '';
  }
  #rebuildColors(): void {
    const out = new Map<number, string>(), tf = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    for (const r of this.#records) {
      const held = r.on ? this.#held.get(r.id) : undefined;
      if (!held?.result.ok || !held.result.candleColors || held.tf !== tf || held.inst !== this.store.state.seriesInstrument) continue;
      held.result.candleColors.forEach((c, i) => { if (c) out.set(held.time[i]!, safeColor(c, '')); });
    }
    this.#candleColors = out;
  }

  /**
   * Draw the scripts placed on the map (called by the map, in its plot's coordinates): the plots on the price scale at their prices, the
   * others each on a scale of their own, fitted to what is in view inside their margins, as they would be over a chart's candles.
   */
  paintOnMap(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    const state = this.store.state;
    if (!state.show.script) return;
    // The map asks for runs too: on a phone the pane is not laid out while another tab shows, and the scripts on the map must still run.
    this.#maybeRun();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.palette;
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    for (const r of this.#records) {
      if (!r.on || r.place !== 'map') continue;
      const held = this.#held.get(r.id);
      if (!held?.result.ok || held.tf !== tf || held.inst !== state.seriesInstrument || !held.time.length) continue;
      const res = held.result, time = held.time, [from, to] = visibleRange(time, v.t0, v.t1, tf);
      const scales = scalesOf(res.plots.filter(pl => scaleIdOf(pl, r.options) !== 'right'), r.options, from, to);
      scales.set('right', { min: v.p0, max: v.p1, margins: { top: 0, bottom: 0 } });
      const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top: 0, height: ph, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
      res.plots.forEach((plot, j) => {
        const s = scales.get(scaleIdOf(plot, r.options));
        if (s) paintPlot({ ...frame, color: fallbacks[j % fallbacks.length]! }, plot, s);
      });
    }
  }

  /** The popup lines of one script at the candle under the pointer: its name, then each plot's value there. */
  #cardLines(out: InfoLine[], r: ScriptRecord, res: Extract<ScriptResult, { ok: true }>, time: Float64Array, tf: number, at: number): void {
    let lo = 0, hi = time.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (time[m]! <= at) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i < 0 || at >= time[i]! + tf) return;
    if (!out.length) out.push({ text: clock(time[i]!, true), bold: true });
    out.push({ text: r.name, bold: true, rule: true });
    res.plots.forEach((plot, j) => {
      if (plot.style.visible === false) return;
      const values = PLOT_FIELDS[plot.kind].map(f => plot.fields[f]![i]!);
      if (!values.some(Number.isFinite)) return;
      const text = values.length === 1 ? shortNumber(values[0]!) : values.map(shortNumber).join(plot.kind === 'cloudarea' || plot.kind === 'brokenarea' ? ' – ' : ' / ');
      out.push({ label: plot.title || `${plot.kind} ${j + 1}`, text, color: values.length === 1 && values[0]! < 0 ? 'sell' : 'text' });
    });
  }
}
