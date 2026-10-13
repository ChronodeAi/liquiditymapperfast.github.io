import { TIMEFRAMES, type Hub } from '../hub.ts';
import { oiMarketIds } from '../market-choice.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { LS_VENUES, type LsMetric, type LsPoint, type LsPopulation, type LsSeries } from '../../shared/long-short.ts';

const MINUTE = 60_000, HOUR = 3_600_000;
/** One colour per venue, apart from each other on either theme (the brands' own are black on two of them); the venue's mark ends its line. */
const LINE_COLORS: Readonly<Record<string, string>> = { binance: '#d4a106', bybit: '#e8590c', okx: '#7a5af8', bitget: '#0ca5b8' };
/** A reading stands until the next one, or for this many of its periods after it when none follows (a gap past that breaks the line). */
const HOLD_PERIODS = 3;

/** The markets the pane shows: the OI pane's markets (those it adds together, or its one market) on a venue that publishes a ratio. */
export function lsIds(state: AppState, hub: Hub): string[] {
  const ids = oiMarketIds(state, hub.flow) ?? [state.oiInstrument || state.seriesInstrument || state.marketId];
  const venue = (id: string): number => LS_VENUES.indexOf(id.split(':')[0]!);
  return [...new Set(ids)].filter(id => venue(id) >= 0).sort((a, b) => venue(a) - venue(b));
}

/** The words for who a series counts. */
export function populationText(population: LsPopulation): string {
  return population === 'accounts' ? t('all accounts') : population === 'topAccounts' ? t('top traders, by accounts') : population === 'topPositions' ? t('top traders, by positions') : t('active accounts');
}

/** Where the step of a series' reading `i` ends: at the next reading where it comes within the hold, else a period after it. */
export function stepEnd(s: Pick<LsSeries, 'points' | 'periodMs'>, i: number): number {
  const q = s.points[i]!, next = s.points[i + 1];
  return next && next.t - q.t <= HOLD_PERIODS * s.periodMs ? next.t : q.t + s.periodMs;
}

/** The reading of `points` (oldest first) in effect at `time`: the last one at or before it, while its hold lasts. */
export function lsAt(points: readonly LsPoint[], time: number, periodMs: number): LsPoint | null {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid]!.t <= time) lo = mid + 1; else hi = mid; }
  const p = points[lo - 1];
  return p && time < p.t + HOLD_PERIODS * periodMs ? p : null;
}

/** "55.6 % long · 44.4 % short · L/S 1.25" for a long share. */
export function shareText(long: number): string {
  return t('{long} long · {short} short · L/S {ratio}', { long: `${(long * 100).toFixed(1)}%`, short: `${((1 - long) * 100).toFixed(1)}%`, ratio: (long / (1 - long)).toFixed(2) });
}

/** The popup of one moment: each venue's reading then (or why it has none), and what the numbers count. */
export function lsCardLines(series: readonly LsSeries[], time: number, tf: string): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${clock(time, true)} · ${tf}`, bold: true }];
  for (const s of series) {
    const label = venueLabel(s.id);
    if (s.status === 'serverOnly') { lines.push({ label, text: t('read by the server only'), color: 'muted', mark: s.id }); continue; }
    if (s.status === 'failed') { lines.push({ label, text: t('could not be read'), color: 'muted', mark: s.id }); continue; }
    const p = lsAt(s.points, time, s.periodMs);
    lines.push(p ? { label, text: shareText(p.long), color: p.long > 0.5 ? 'buy' : p.long < 0.5 ? 'sell' : 'text', mark: s.id } : { label, text: t('no reading'), color: 'muted', mark: s.id });
  }
  // Who each line counts, the venues of one population together: "Binance: top traders, by positions · Bybit, OKX: all accounts".
  const groups = new Map<LsPopulation, string[]>();
  for (const s of series) if (s.population) groups.set(s.population, [...(groups.get(s.population) ?? []), venueLabel(s.id)]);
  if (groups.size) lines.push({ text: [...groups].map(([population, venues]) => `${venues.join(', ')}: ${populationText(population)}`).join(' · '), color: 'muted', wrap: true, rule: true });
  lines.push({ text: t('Accounts as each exchange counts them, not coins: L/S 1.25 is 1.25 long accounts for each short one, not 25 % more BTC long. In coins the two sides are always equal.'), color: 'muted', wrap: true });
  return lines;
}

/**
 * The Long/Short pane: the share of each venue's accounts that is net long, as the venue publishes it (shared/long-short.ts), one line per
 * venue around a 50 % line. The venues are the OI pane's markets that publish one; Binance's series is chosen in the header. A pane off by
 * default: nothing is read while it is hidden, and its readings are asked for again at most once a minute.
 */
export class LsPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #series: LsSeries[] = [];
  #key = ''; #asked = 0; #generation = 0;
  #sync: (() => void)[] = [];

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'ls');
    this.head.innerHTML = `<strong>${t('Long/Short')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('lsPane'));
    setTip(this.head.querySelector('strong')!, t('The share of each exchange\'s accounts that is net long, as the exchange publishes it.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    const wrap = document.createElement('label'); wrap.className = 'ctl'; wrap.append('Binance');
    setTip(wrap, t('Which of Binance\'s three series: every account, its top traders counted by account, or its top traders counted by the size of their positions.'));
    const control = document.createElement('select');
    for (const [value, text] of [['accounts', t('All accounts')], ['topAccounts', t('Top traders, accounts')], ['topPositions', t('Top traders, positions')]] as const) control.append(new Option(text, value));
    control.value = store.state.lsMetric;
    control.onchange = () => this.store.set({ lsMetric: control.value as LsMetric });
    wrap.append(control); group.append(wrap);
    this.#sync.push(() => { if (control.value !== this.store.state.lsMetric) control.value = this.store.state.lsMetric; });
  }

  /** Reflect the settings in the header and read again. */
  settingsChanged(): void { for (const sync of this.#sync) sync(); this.#key = ''; this.invalidate(); }

  /** Ask for the readings of the view (and half a view before it), again when what is shown changed or a minute after the last time. */
  #load(state: AppState, ids: readonly string[], tfMs: number): void {
    const v = this.view, span = v.t1 - v.t0, from = Math.floor((v.t0 - span / 2) / HOUR) * HOUR, to = Math.ceil((Math.max(v.t1, Date.now()) + tfMs) / MINUTE) * MINUTE;
    const key = `${ids.join(',')}|${state.lsMetric}|${state.timeframe}|${from}`;
    if (key === this.#key && Date.now() - this.#asked < MINUTE) return;
    const stale = key !== this.#key, generation = ++this.#generation, source = this.hub.source;
    this.#key = key; this.#asked = Date.now();
    if (stale) this.#series = [];
    void Promise.all(ids.map(id => source.longShort(id, state.lsMetric, state.timeframe, from, to).catch((): LsSeries => ({ id, population: null, periodMs: 0, points: [], status: 'failed' }))))
      .then(series => { if (generation === this.#generation) { this.#series = series; this.invalidate(); } });
  }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? HOUR, readout = this.head.querySelector('.readout');
    const ids = lsIds(state, this.hub);
    if (!ids.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(t('None of the open-interest markets is on an exchange that publishes a long/short ratio (Binance, Bybit, OKX, Bitget).'), 12, ph / 2);
      setHtml(readout, ''); return;
    }
    this.#load(state, ids, tf);
    // Replay: only what had been published by the moment shown.
    const series = this.#series.filter(s => ids.includes(s.id)).map(s => replaying() ? { ...s, points: s.points.filter(q => q.t + s.periodMs <= now) } : s);
    const shown = series.filter(s => s.points.length);
    let lo = Infinity, hi = -Infinity;
    // Over the steps drawn: a reading counts while it holds (until the next), as the lines are drawn.
    for (const s of shown) s.points.forEach((q, i) => { if (stepEnd(s, i) >= v.t0 && q.t <= v.t1) { lo = Math.min(lo, q.long); hi = Math.max(hi, q.long); } });
    if (lo > hi) { lo = 0.45; hi = 0.55; }
    const pad = Math.max((hi - lo) * 0.1, 0.005), min = lo - pad, max = hi + pad, top = 8, bottom = ph - 8;
    const y = (share: number): number => top + (1 - (share - min) / (max - min)) * (bottom - top);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // Half long, half short, where it is inside the scale (the scale fits the lines: they move by tenths of a percent).
    if (min < 0.5 && max > 0.5) {
      ctx.strokeStyle = p.muted; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, Math.round(y(0.5)) + 0.5); ctx.lineTo(pw, Math.round(y(0.5)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    }
    const ends: { id: string; x: number; y: number }[] = [];
    for (const s of shown) {
      // Steps: a reading holds until the next, and a gap longer than its hold breaks the line.
      ctx.strokeStyle = LINE_COLORS[s.id.split(':')[0]!] ?? p.text; ctx.lineWidth = 1.5; ctx.beginPath();
      let last: { x: number; y: number } | null = null, prevEnd = -Infinity;
      for (let i = 0; i < s.points.length; i++) {
        const q = s.points[i]!, end = stepEnd(s, i);
        if (end < v.t0 || q.t > v.t1) { prevEnd = end; continue; }
        const x0 = v.xOf(q.t, pw), x1 = v.xOf(end, pw), yq = y(q.long);
        if (last && prevEnd === q.t) ctx.lineTo(x0, yq); else ctx.moveTo(x0, yq);
        ctx.lineTo(x1, yq); last = { x: x1, y: yq }; prevEnd = end;
      }
      ctx.stroke(); ctx.lineWidth = 1;
      if (last) ends.push({ id: s.id, ...last });
    }
    // Each line's venue mark where it ends, kept apart from the others.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 14 && Math.abs(ends[i]!.x - ends[i - 1]!.x) < 14) ends[i]!.y = ends[i - 1]!.y + 14;
    for (const e of ends) drawVenueMark(ctx, e.id, Math.min(pw - 8, e.x + 8), Math.max(top + 6, Math.min(bottom - 6, e.y)), 12);
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
    ctx.fillText(pct(hi), this.w - AXIS_W + 6, y(hi)); ctx.fillText(pct(lo), this.w - AXIS_W + 6, y(lo));
    if (min < 0.5 && max > 0.5 && Math.abs(y(0.5) - y(hi)) > 14 && Math.abs(y(0.5) - y(lo)) > 14) ctx.fillText('50%', this.w - AXIS_W + 6, y(0.5));
    if (!shown.length) {
      ctx.textAlign = 'left';
      ctx.fillText(this.#series.length ? t('No long/short readings for this time.') : t('Reading the long/short ratios…'), 12, ph / 2);
    }
    // Readout and popup: the moment under the pointer, else now; past the newest reading (or over the price axis), the newest, and the cursor there.
    const newest = Math.max(-Infinity, ...shown.map(s => s.points[s.points.length - 1]!.t));
    let time = state.hover ? state.hover.t : Math.min(now, v.t1);
    if (time > newest && Number.isFinite(newest) && shown.every(s => !lsAt(s.points, time, s.periodMs))) { time = newest; if (state.hover && this.pointer) this.cursorT = newest; }
    const hover = state.hover;
    if (hover && this.pointer) this.#lines = lsCardLines(series, time, state.timeframe);
    const parts = series.map(s => {
      const q = lsAt(s.points, time, s.periodMs), name = venueLabel(s.id);
      if (s.status === 'serverOnly') return `<span class="muted">${name} ${t('server only')}</span>`;
      return q ? `${name} <b class="${q.long > 0.5 ? 'bid' : q.long < 0.5 ? 'ask' : ''}">${pct(q.long)}</b>` : `<span class="muted">${name} –</span>`;
    });
    setHtml(readout, `${t('long')} ${parts.join(' ')}`);
  }
}
