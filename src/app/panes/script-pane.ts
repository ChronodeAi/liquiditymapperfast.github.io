import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
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
import { analyze, type Analysis } from '../script/lang/engine.ts';
import { ScriptSyntaxError, type ScriptError } from '../script/lang/lexer.ts';
import { loadScripts, storeScripts, type ScriptRecord } from '../script/records.ts';
import { PLOT_FIELDS, type ScriptResult, type Warning } from '../script/protocol.ts';
import { paintPlot, scaleIdOf, scalesOf, shortNumber, visibleRange, yOf, type Frame } from '../script/paint.ts';
import { errorText } from '../script/messages.ts';
import type { SourceFilter } from '../script/inputs.ts';
import { buildScriptsPanel, type ScriptsPanelState } from '../script/panel.ts';

/** What the pane knows of a script between runs. */
interface Held { result: ScriptResult; time: Float64Array; tf: number }

/** How often a script runs at most (ms), and how often it runs again anyway while nothing it reads changes (the candle under way fills in). */
const MIN_INTERVAL = 1_000, REFRESH = 15_000;

/**
 * The Scripts pane: a row for each of the person's scripts that is switched on, each with its own scales, drawn over the map's time axis.
 * The scripts run in a worker of their own (script/script.worker.ts), never on this thread; this pane gathers what they read
 * (script/data.ts), asks for a run at most once a second, and less often when a run takes longer (four times its length apart), so a heavy
 * script cannot keep a core busy. The Scripts… button opens the panel that lists, writes, imports and exports them (script/panel.ts).
 */
export class ScriptPane extends TimePane {
  #records: ScriptRecord[] = loadScripts();
  #version = 0;
  #host = new ScriptHost({ spawn: () => new Worker(new URL('../script/script.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike });
  #data: ScriptData;
  #analysis = new Map<string, Analysis | ScriptError>();
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

  /** Keep `list` as the scripts; false when this browser refused to store it (the list still applies until the page closes). */
  setRecords(list: ScriptRecord[]): boolean {
    this.#records = list;
    this.#version++;
    for (const id of [...this.#held.keys()]) if (!list.some(r => r.id === id)) this.#held.delete(id);
    const kept = storeScripts(list);
    this.#lastRun = 0;
    this.invalidate();
    return kept;
  }

  readonly #build = (_tools: HTMLElement, body: HTMLElement): void => buildScriptsPanel(this, body, () => this.#panel?.render(this.#build), this.#ui);
  openPanel(): void {
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
    const seen = { candles: state.candles, loads: this.hub.flow.loads, data: this.#data.version, version: this.#version, tf: state.timeframe, markets: state.markets, venues: state.disabledVenues, scope: state.scope };
    const was = this.#seen, now = Date.now();
    const changed = !was || Object.keys(seen).some(k => (seen as Record<string, unknown>)[k] !== (was as Record<string, unknown>)[k]);
    if (!changed && now - this.#lastRun < REFRESH) return;
    const interval = Math.max(MIN_INTERVAL, this.#runMs * 4), wait = this.#lastRun + interval - now;
    if (wait > 0) { if (!this.#timer) this.#timer = window.setTimeout(() => { this.#timer = 0; this.invalidate(); }, wait); return; }
    this.#seen = seen;
    this.#run(on);
  }

  #run(on: readonly ScriptRecord[]): void {
    const state = this.store.state;
    const filters = new Map<string, SourceFilter>([['', {}]]);
    const runnable: ScriptRecord[] = [];
    for (const r of on) {
      const a = this.#analyze(r.source);
      if (!('program' in a)) { this.#held.set(r.id, { result: { id: r.id, ok: false, error: a }, time: new Float64Array(0), tf: 0 }); continue; }
      for (const [k, f] of a.sources) filters.set(k, f);
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
      for (const [k] of a.sources) if (k && !markets.get(k)?.length) w.push({ code: 'no-markets', detail: k.replace(/;/g, ', ') });
      this.#warnings.set(r.id, w);
    }
    const time = inputs.time.slice(), tf = inputs.tf, started = Date.now();
    this.#running = true; this.#lastRun = started;
    void this.#host.run(runnable.map(r => ({ id: r.id, source: r.source, options: r.options, api: r.api })), inputs).then(results => {
      this.#running = false;
      if (!results.length) return;
      this.#runMs = Date.now() - started;
      for (const res of results) this.#held.set(res.id, { result: res, time, tf });
      this.invalidate();
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
    const on = this.#records.filter(r => r.on);
    setText(this.head.querySelector('.readout'), this.#records.length ? tn(on.length, '{n} script on', '{n} scripts on') : '');
    ctx.textBaseline = 'middle';
    if (!on.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(this.#records.length ? t('Every script is switched off: switch one on in Scripts….') : t('No scripts yet: open Scripts… to write one or add an example.'), 12, ph / 2);
      return;
    }
    const total = on.reduce((s, r) => s + r.height, 0);
    let top = 0;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const hv = state.hover;
    const card: InfoLine[] = [];
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    on.forEach((r, k) => {
      const rowH = k === on.length - 1 ? ph - top : Math.max(24, Math.round(ph * r.height / total));
      const held = this.#held.get(r.id);
      if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.w, top + 0.5); ctx.stroke(); }
      const label = (text: string, color: string, y: number): void => { ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, 6, y); };
      if (!held) label(`${r.name} · ${t('running…')}`, p.muted, top + 9);
      else if (!held.result.ok) { label(r.name, p.text, top + 9); ctx.save(); ctx.beginPath(); ctx.rect(0, top, pw, rowH); ctx.clip(); label(errorText(held.result.error), p.ask, top + 24); ctx.restore(); }
      else {
        const res = held.result, time = held.time;
        // A run for another timeframe is not drawn over this one: the next run replaces it.
        if (held.tf === tf && time.length) {
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
