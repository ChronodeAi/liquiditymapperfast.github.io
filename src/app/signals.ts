/**
 * The Signals overlay on the main chart: the local server's volatility-ahead warnings (a 5m, 15m or 1h bar that traded far more than usual
 * while price hardly moved: a large move often follows, its side unknown), and the minutes its volatility watch named a side (Jev's
 * assessment, the confluence's call), filtered by the page's settings, each with what price did after it. The sides have shown no edge.
 */
import { SIGNAL_MIN_SCORE, type Signal } from '../shared/volatility/signals.ts';
import { AHEAD, type AheadWarning } from '../shared/volatility/ahead.ts';
import { WARN_MIN_SCORE } from '../shared/volatility/jev.ts';
import { clock, price as fmtPrice, usd } from './format.ts';
import { t } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

/**
 * Whether they show, the volatility-ahead warnings, which kinds of sided signal, the lowest Jev score drawn, and whether Jev signals made
 * while price was already moving show too. The warnings are on by default and the sided signals off: they have shown no edge.
 */
export interface SignalSettings { on: boolean; ahead: boolean; jev: boolean; confluence: boolean; minScore: number; duringMoves: boolean }
export const SIGNAL_DEFAULTS: Readonly<SignalSettings> = { on: false, ahead: true, jev: false, confluence: false, minScore: WARN_MIN_SCORE, duringMoves: false };
/** The Jev score the page can ask for: from the lowest kept as a candidate to the top of the scale, in halves. */
export const SIGNAL_SCORE = { min: SIGNAL_MIN_SCORE, max: 4, step: 0.5 } as const;

/** Saved settings, each field checked (anything else is the default). */
export function readSignals(saved: unknown): SignalSettings {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof SignalSettings, unknown>>, d = SIGNAL_DEFAULTS;
  const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;
  const score = typeof s.minScore === 'number' && Number.isFinite(s.minScore)
    ? Math.round(Math.min(SIGNAL_SCORE.max, Math.max(SIGNAL_SCORE.min, s.minScore)) / SIGNAL_SCORE.step) * SIGNAL_SCORE.step : d.minScore;
  return { on: flag(s.on, d.on), ahead: flag(s.ahead, d.ahead), jev: flag(s.jev, d.jev), confluence: flag(s.confluence, d.confluence), minScore: score, duringMoves: flag(s.duringMoves, d.duringMoves) };
}

/** Whether the settings draw a signal. */
export function signalShown(s: Signal, settings: SignalSettings): boolean {
  if (s.kind === 'confluence') return settings.confluence;
  if (!settings.jev || !s.jev || s.jev.score < settings.minScore) return false;
  return settings.duringMoves || s.jev.underway === false;
}

/** Calls of one kind and side at most this far apart are one episode, and the chart marks only its first. */
export const EPISODE_GAP_MS = 5 * 60_000;
/** How far before a window episodes are followed back, so one that began before it is not marked again part of the way through. */
const EPISODE_LOOKBACK_MS = 6 * 3_600_000;

/** A signal as the chart draws it: the first call of its episode, with how many calls the episode held and the time of its last. */
export type ShownSignal = Signal & { episode: { count: number; last: number } };

/**
 * The signals held for the chart, one per kind and minute, in time order. An answer again for a minute replaces what was held (its results
 * fill in as the minutes after it are known). At most `max` are kept, the oldest outside the window last asked for going first.
 */
export class SignalBook {
  items: Signal[] = [];
  /** The volatility-ahead warnings, one per timeframe and bar, in time order; an answer again replaces (what price did after fills in). */
  ahead: AheadWarning[] = [];
  /** Bumped whenever the contents change, so a painter can tell its cache is stale. */
  version = 0;
  #byKey = new Map<string, Signal>();
  #aheadByKey = new Map<string, AheadWarning>();
  constructor(private max = 20_000) {}

  /** Merge an answer's signals; `keep` is the window it was asked for. */
  add(signals: Iterable<Signal>, keep?: { from: number; to: number }): void {
    let changed = false;
    for (const s of signals) {
      const key = `${s.kind}:${s.t}`, had = this.#byKey.get(key);
      if (had && JSON.stringify(had) === JSON.stringify(s)) continue;
      this.#byKey.set(key, s); changed = true;
    }
    if (!changed) return;
    let items = [...this.#byKey.values()].sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : 1));
    if (items.length > this.max) {
      const over = items.length - this.max, gone = new Set<Signal>();
      for (const s of items) { if (gone.size >= over) break; if (!keep || s.t < keep.from || s.t >= keep.to) gone.add(s); }
      for (const s of items) { if (gone.size >= over) break; gone.add(s); }
      items = items.filter(s => !gone.has(s));
      for (const s of gone) this.#byKey.delete(`${s.kind}:${s.t}`);
    }
    this.items = items; this.version++;
  }

  /** Merge an answer's volatility-ahead warnings (a few a day: all are kept). */
  addAhead(warnings: Iterable<AheadWarning>): void {
    let changed = false;
    for (const w of warnings) {
      const key = `${w.tf}:${w.t}`, had = this.#aheadByKey.get(key);
      if (had && JSON.stringify(had) === JSON.stringify(w)) continue;
      this.#aheadByKey.set(key, w); changed = true;
    }
    if (!changed) return;
    this.ahead = [...this.#aheadByKey.values()].sort((a, b) => a.t - b.t || a.tf - b.tf); this.version++;
  }

  clear(): void {
    if (!this.items.length && !this.ahead.length) return;
    this.items = []; this.#byKey.clear(); this.ahead = []; this.#aheadByKey.clear(); this.version++;
  }

  /** The volatility-ahead warnings the settings draw that ended in [from, to) and before `until` (replay passes its moment), oldest first. */
  aheadVisible(from: number, to: number, settings: SignalSettings, until = Infinity): AheadWarning[] {
    return settings.ahead ? this.ahead.filter(w => w.t >= from && w.t < to && w.t < until) : [];
  }

  /**
   * The episodes the settings draw that begin in [from, to), oldest first, each as its first call. Calls are grouped by kind and side once
   * the settings have filtered them; an episode that began before `from` is not drawn, and one still going at `to` keeps counting calls up
   * to `until` (replay passes its moment, so nothing after it is counted).
   */
  visible(from: number, to: number, settings: SignalSettings, until = Infinity): ShownSignal[] {
    const items = this.items;
    let i = 0, hi = items.length;
    while (i < hi) { const mid = (i + hi) >> 1; if (items[mid]!.t < from - EPISODE_LOOKBACK_MS) i = mid + 1; else hi = mid; }
    const open = new Map<string, ShownSignal>(), out: ShownSignal[] = [];
    for (; i < items.length; i++) {
      const s = items[i]!;
      if (s.t >= until) break;
      if (s.t >= to && ![...open.values()].some(e => e.t >= from && s.t - e.episode.last <= EPISODE_GAP_MS)) break;
      if (!signalShown(s, settings)) continue;
      const key = `${s.kind}:${s.side}`, head = open.get(key);
      if (head && s.t - head.episode.last <= EPISODE_GAP_MS) { head.episode.count++; head.episode.last = s.t; continue; }
      if (s.t >= to) continue;
      const shown: ShownSignal = { ...s, episode: { count: 1, last: s.t } };
      open.set(key, shown);
      if (s.t >= from) out.push(shown);
    }
    return out;
  }
}

/** Basis points signed so positive went the signal's way, or 'Too recent' while not known. */
const bpText = (v: number | null): string => v === null ? t('Too recent') : `${v > 0 ? '+' : ''}${v.toFixed(1)} bp`;
const bpColor = (v: number | null): InfoLine['color'] => v === null ? 'muted' : v > 0 ? 'buy' : v < 0 ? 'sell' : 'text';

/** The box for a signal under the pointer; for the first call of an episode of several, how many calls it held and over how long. */
export function signalLines(s: Signal & { episode?: ShownSignal['episode'] }): InfoLine[] {
  const long = s.side === 'long';
  const title = s.kind === 'jev' ? (long ? t('Long: Jev warning') : t('Short: Jev warning')) : (long ? t('Long: confluence call') : t('Short: confluence call'));
  const lines: InfoLine[] = [
    { text: title, bold: true, color: long ? 'buy' : 'sell' },
    { label: t('Time'), text: clock(s.t, true) },
    { label: t('Price'), text: fmtPrice(s.price) },
  ];
  if (s.episode && s.episode.count > 1) lines.push({ label: t('Calls in this episode'), text: `${s.episode.count} · ${t('{n} min', { n: String(Math.round((s.episode.last - s.t) / 60_000)) })}` });
  if (s.jev) {
    lines.push({ label: t('Jev score'), text: `${s.jev.score.toFixed(1)} / 4`, rule: true });
    lines.push({ label: t('Confidence'), text: `${Math.round(s.jev.confidence * 100)}%` });
    lines.push({ label: long ? t('Probability up') : t('Probability down'), text: `${Math.round(s.jev.p * 100)}%` });
    if (s.jev.underway === true) lines.push({ text: t('Price was already moving'), color: 'muted' });
  }
  if (s.confluence) {
    lines.push({ label: t('Confluence score'), text: `${s.confluence.score > 0 ? '+' : ''}${s.confluence.score.toFixed(2)}`, rule: true });
    lines.push({ label: t('Families agreeing / against'), text: `${s.confluence.agree} / ${s.confluence.against}` });
    if (s.confluence.triggers.length) lines.push({ label: t('Triggers'), text: s.confluence.triggers.join(', '), wrap: true });
  }
  const a = s.after;
  lines.push({ label: t('After 5 min'), text: bpText(a.r5), color: bpColor(a.r5), rule: true });
  lines.push({ label: t('After 15 min'), text: bpText(a.r15), color: bpColor(a.r15) });
  lines.push({ label: t('After 30 min'), text: bpText(a.r30), color: bpColor(a.r30) });
  lines.push({ label: t('Best within 15 min'), text: bpText(a.best15), color: bpColor(a.best15) });
  lines.push({ label: t('Worst within 15 min'), text: bpText(a.worst15), color: bpColor(a.worst15) });
  lines.push({ text: t('Experimental: these signals have shown no edge yet.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** What the signals did over 15 minutes: how many, how many are known yet, their mean (bp, its way positive) and the share that went its way. */
export interface SignalSummary { count: number; known: number; meanR15: number | null; positive: number | null }
export function summaryOf(signals: readonly Signal[]): SignalSummary {
  const known = signals.flatMap(s => s.after.r15 === null ? [] : [s.after.r15]);
  return {
    count: signals.length, known: known.length,
    meanR15: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
    positive: known.length ? known.filter(r => r > 0).length / known.length : null,
  };
}

/** A timeframe of the warnings as the chart writes it. */
export const tfLabel = (tf: AheadWarning['tf']): string => tf === 60 ? '1h' : `${tf}m`;

/** The box for a volatility-ahead ring under the pointer: the bar, where a breakout and a full move would be, and what price has done since. */
export function aheadLines(w: AheadWarning): InfoLine[] {
  const a = w.after, at = (k: number): string => fmtPrice(w.price * (1 + k * w.sigma));
  const dollars = (bp: number): string => `$${usd(Math.abs(bp) / 1e4 * w.price)}`;
  const lines: InfoLine[] = [
    { text: t('Volatility ahead ({tf})', { tf: tfLabel(w.tf) }), bold: true },
    { label: t('Bar closed'), text: clock(w.t, true) },
    { label: t('Price'), text: fmtPrice(w.price) },
    { label: t('Volume'), text: t('{times}× its usual (z {z})', { times: w.times.toFixed(1), z: w.z.toFixed(1) }) },
    { label: t('σ, the usual 3-bar move'), text: `${(w.sigma * 100).toFixed(2)} % · $${usd(w.price * w.sigma)}` },
    { label: t('Breakout at (±1σ)'), text: `${at(1)} / ${at(-1)}`, rule: true },
    { label: t('Big move reaches (±2σ)'), text: `${at(AHEAD.move)} / ${at(-AHEAD.move)}` },
    { label: t('Watching until'), text: clock(w.t + AHEAD.bars * w.tf * 60_000, true) },
  ];
  if (a.moved && a.at !== null) lines.push({ text: a.moved === 'up' ? t('Moved up 2σ by {time}', { time: clock(a.at) }) : t('Moved down 2σ by {time}', { time: clock(a.at) }), color: a.moved === 'up' ? 'buy' : 'sell', rule: true });
  else lines.push({ text: a.done ? t('No 2σ move within its 6 bars') : t('Still watching'), color: 'muted', rule: true });
  if (a.up !== null && a.down !== null) lines.push({ label: t('Furthest up / down'), text: `+${a.up.toFixed(1)} bp (${dollars(a.up)}) / ${a.down.toFixed(1)} bp (${dollars(a.down)})` });
  lines.push({ text: t('In tests on Binance BTCUSDT from 2024 to 2026, a 2σ move followed within 6 bars after 55 % of these rings at 5m, 67 % at 15m and 61 % at 1h, against 22 to 26 % of other quiet bars. A ring does not say which way.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** What the warnings in view were followed by: how many, how many are over, and how many of those saw a 2σ move. */
export function aheadSummaryOf(warnings: readonly AheadWarning[]): { count: number; done: number; moved: number } {
  const done = warnings.filter(w => w.after.done);
  return { count: warnings.length, done: done.length, moved: done.filter(w => w.after.moved !== null).length };
}
