/**
 * The Signals overlay on the main chart: the minutes the local server's volatility watch named a side (Jev's assessment, the confluence's
 * call), filtered by the page's settings, each with what price did after it. Experimental: none of them has shown an edge yet.
 */
import { SIGNAL_MIN_SCORE, type Signal } from '../shared/volatility/signals.ts';
import { WARN_MIN_SCORE } from '../shared/volatility/jev.ts';
import { clock, price as fmtPrice } from './format.ts';
import { t } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

/** Whether they show, which kinds, the lowest Jev score drawn, and whether Jev signals made while price was already moving show too. */
export interface SignalSettings { on: boolean; jev: boolean; confluence: boolean; minScore: number; duringMoves: boolean }
export const SIGNAL_DEFAULTS: Readonly<SignalSettings> = { on: false, jev: true, confluence: true, minScore: WARN_MIN_SCORE, duringMoves: false };
/** The Jev score the page can ask for: from the lowest kept as a candidate to the top of the scale, in halves. */
export const SIGNAL_SCORE = { min: SIGNAL_MIN_SCORE, max: 4, step: 0.5 } as const;

/** Saved settings, each field checked (anything else is the default). */
export function readSignals(saved: unknown): SignalSettings {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof SignalSettings, unknown>>, d = SIGNAL_DEFAULTS;
  const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;
  const score = typeof s.minScore === 'number' && Number.isFinite(s.minScore)
    ? Math.round(Math.min(SIGNAL_SCORE.max, Math.max(SIGNAL_SCORE.min, s.minScore)) / SIGNAL_SCORE.step) * SIGNAL_SCORE.step : d.minScore;
  return { on: flag(s.on, d.on), jev: flag(s.jev, d.jev), confluence: flag(s.confluence, d.confluence), minScore: score, duringMoves: flag(s.duringMoves, d.duringMoves) };
}

/** Whether the settings draw a signal. */
export function signalShown(s: Signal, settings: SignalSettings): boolean {
  if (s.kind === 'confluence') return settings.confluence;
  if (!settings.jev || !s.jev || s.jev.score < settings.minScore) return false;
  return settings.duringMoves || s.jev.underway === false;
}

/**
 * The signals held for the chart, one per kind and minute, in time order. An answer again for a minute replaces what was held (its results
 * fill in as the minutes after it are known). At most `max` are kept, the oldest outside the window last asked for going first.
 */
export class SignalBook {
  items: Signal[] = [];
  /** Bumped whenever the contents change, so a painter can tell its cache is stale. */
  version = 0;
  #byKey = new Map<string, Signal>();
  constructor(private max = 20_000) {}

  /** Merge an answer; `keep` is the window it was asked for. */
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

  clear(): void { if (!this.items.length) return; this.items = []; this.#byKey.clear(); this.version++; }

  /** The signals in [from, to) the settings draw, oldest first. */
  visible(from: number, to: number, settings: SignalSettings): Signal[] {
    const items = this.items;
    let lo = 0, hi = items.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid]!.t < from) lo = mid + 1; else hi = mid; }
    const out: Signal[] = [];
    for (let i = lo; i < items.length && items[i]!.t < to; i++) if (signalShown(items[i]!, settings)) out.push(items[i]!);
    return out;
  }
}

/** Basis points signed so positive went the signal's way, or 'Too recent' while not known. */
const bpText = (v: number | null): string => v === null ? t('Too recent') : `${v > 0 ? '+' : ''}${v.toFixed(1)} bp`;
const bpColor = (v: number | null): InfoLine['color'] => v === null ? 'muted' : v > 0 ? 'buy' : v < 0 ? 'sell' : 'text';

/** The box for a signal under the pointer. */
export function signalLines(s: Signal): InfoLine[] {
  const long = s.side === 'long';
  const title = s.kind === 'jev' ? (long ? t('Long: Jev warning') : t('Short: Jev warning')) : (long ? t('Long: confluence call') : t('Short: confluence call'));
  const lines: InfoLine[] = [
    { text: title, bold: true, color: long ? 'buy' : 'sell' },
    { label: t('Time'), text: clock(s.t, true) },
    { label: t('Price'), text: fmtPrice(s.price) },
  ];
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
