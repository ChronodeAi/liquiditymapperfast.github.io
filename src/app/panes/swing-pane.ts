import { TIMEFRAMES } from '../hub.ts';
import type { Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { SWING_HIGH, SWING_LENGTH, SWING_LOW, VALUE_CHEAP, VALUE_HOT, VALUE_LENGTH, swingZone, valueZone, type SwingRow } from '../swing/model.ts';
import type { SwingBook } from '../swing/book.ts';

/** The cheap/hot strip's middle zone: amber, neither side's colour. */
const NEUTRAL = '#f5c518';
/** The cheap/hot reading is drawn as a dark area over its zones, which read through on any theme. */
const AREA = 'rgba(0,0,0,0.88)';
/** The share of the pane's height the Swing strip takes; the cheap/hot strip has the rest under a small gap. */
const SWING_SHARE = 0.6, GAP = 6;

const fixed = (v: number | null): string => v === null ? '–' : v.toFixed(1);
const zoneWord = (row: SwingRow): string => { const z = swingZone(row); return z === 'floor' ? t('floor of the range') : z === 'ceiling' ? t('ceiling of the range') : ''; };
const valueWord = (v: number): string => { const z = valueZone(v); return z === 'cheap' ? t('cheap') : z === 'hot' ? t('hot') : t('neutral'); };

/** The popup of one candle: both Swing lines, the trend and the zone; the cheap/hot reading and its zone; and what they are. */
export function swingCardLines(row: SwingRow, tf: string, market: string): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${t('Swing')} · ${tf}`, bold: true }, { label: t('Candle'), text: clock(row.t, true) }];
  lines.push({ label: t('Fast'), text: fixed(row.fast), rule: true }, { label: t('Slow'), text: fixed(row.slow) });
  if (row.up !== null) lines.push({ label: t('Trend'), text: row.up ? t('Up') : t('Down'), color: row.up ? 'buy' : 'sell' });
  const zone = zoneWord(row); if (zone) lines.push({ label: t('Zone'), text: zone, color: swingZone(row) === 'floor' ? 'buy' : 'sell' });
  if (row.value !== null) lines.push({ label: t('Cheap/hot'), text: `${row.value.toFixed(1)} · ${valueWord(row.value)}`, color: valueZone(row.value) === 'cheap' ? 'buy' : valueZone(row.value) === 'hot' ? 'sell' : 'text', rule: true });
  lines.push({ text: t('Swing: where price sits in its last {n} candles, 0 at the bottom and 100 at the top, fast and slow; the bar is green while a Kalman estimate of price rises. Cheap/hot: 100 less a slow {m}-candle stochastic, smoothed, so high is cheap and low is hot. Both say where price sits in its range, not where it goes next. Candles: {market}.', { n: String(SWING_LENGTH), m: String(VALUE_LENGTH), market }), color: 'muted', wrap: true, rule: true });
  return lines;
}

/**
 * The Swing pane: per candle of the chart's timeframe (swing/model.ts), a bar between the fast and slow Swing lines (where price sits in its
 * recent range) coloured by the Kalman trend, over the floor and ceiling zones; and under it the cheap/hot reading as a dark area over its
 * zones (cheap from 50, hot under 17.5). Its candles are the public price history's (swing/book.ts), so it reaches back before the
 * recording and on every timeframe.
 */
export class SwingPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;

  constructor(host: HTMLElement, store: Store, view: View, private book: SwingBook) {
    super(host, store, view, 'swing');
    this.head.innerHTML = `<strong>${t('Swing')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('swingPane'));
    setTip(this.head.querySelector('strong')!, t('Where price sits in its recent range, fast and slow, coloured by its trend; and under it how cheap or hot price is.'));
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
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, readout = this.head.querySelector('.readout');
    const model = this.book.model(state, now, replaying());
    const say = (text: string): void => { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, 12, ph / 2); setHtml(readout, ''); };
    if (!model) { say(t('Price history is not available for this market.')); return; }
    const rows = model.rows.filter(r => r.t + tf >= v.t0 && r.t <= v.t1 && r.t <= now);
    if (!rows.length) {
      say(model.status === 'loading' ? t('Reading price history…') : model.status === 'failed' ? t('Price history could not be loaded; trying again in a minute.') : t('No price history for this time.'));
      return;
    }
    const top1 = 6, bottom1 = Math.round(ph * SWING_SHARE) - GAP / 2, top2 = bottom1 + GAP, bottom2 = ph - 4;
    const y1 = (value: number): number => bottom1 - value / 100 * (bottom1 - top1), y2 = (value: number): number => bottom2 - value / 100 * (bottom2 - top2);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // Swing: the floor and ceiling zones, then a bar a candle between the fast and slow lines.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = p.candleUp; ctx.fillRect(0, y1(SWING_LOW), pw, y1(0) - y1(SWING_LOW));
    ctx.fillStyle = p.candleDown; ctx.fillRect(0, y1(100), pw, y1(SWING_HIGH) - y1(100));
    ctx.globalAlpha = 1;
    for (const r of rows) {
      if (r.fast === null || r.slow === null) continue;
      const x0 = v.xOf(r.t, pw), x1 = v.xOf(r.t + tf, pw), w = Math.max(1, (x1 - x0) * 0.72), x = (x0 + x1) / 2 - w / 2;
      const yt = y1(Math.max(r.fast, r.slow)), yb = y1(Math.min(r.fast, r.slow));
      ctx.fillStyle = r.up === null ? p.muted : r.up ? p.candleUp : p.candleDown;
      ctx.fillRect(x, yt, w, Math.max(1, yb - yt));
    }
    // Cheap/hot: its zones, and the reading as a dark area from 0.
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = p.candleUp; ctx.fillRect(0, y2(100), pw, y2(VALUE_CHEAP) - y2(100));
    ctx.fillStyle = NEUTRAL; ctx.fillRect(0, y2(VALUE_CHEAP), pw, y2(VALUE_HOT) - y2(VALUE_CHEAP));
    ctx.fillStyle = p.candleDown; ctx.fillRect(0, y2(VALUE_HOT), pw, y2(0) - y2(VALUE_HOT));
    ctx.globalAlpha = 1;
    ctx.fillStyle = AREA; ctx.beginPath();
    let open = false, lastX = 0;
    for (const r of rows) {
      if (r.value === null) { if (open) { ctx.lineTo(lastX, y2(0)); ctx.closePath(); open = false; } continue; }
      const x = v.xOf(r.t + tf / 2, pw);
      if (!open) { ctx.moveTo(x, y2(0)); open = true; }
      ctx.lineTo(x, y2(r.value)); lastX = x;
    }
    if (open) { ctx.lineTo(lastX, y2(0)); ctx.closePath(); }
    ctx.fill();
    ctx.restore();
    // The value axes: each strip's zone edges.
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    const ax = this.w - AXIS_W + 6;
    for (const [value, y] of [[SWING_HIGH, y1(SWING_HIGH)], [SWING_LOW, y1(SWING_LOW)], [VALUE_CHEAP, y2(VALUE_CHEAP)], [VALUE_HOT, y2(VALUE_HOT)]] as const) ctx.fillText(String(value), ax, y + 4);
    // Readout and popup: the candle under the pointer, else the newest in view; past the newest, the newest, and the cursor there.
    const time = state.hover ? state.hover.t : Math.min(now, v.t1), newest = rows[rows.length - 1]!;
    const row = [...rows].reverse().find(r => r.t <= time) ?? newest;
    if (state.hover && this.pointer && time >= newest.t + tf) this.cursorT = newest.t + tf / 2;
    const market = `${venueLabel(model.target.id)} ${model.target.listing.symbol}`;
    if (state.hover && this.pointer) this.#lines = swingCardLines(row, state.timeframe, market);
    const zone = swingZone(row), value = row.value;
    const swingText = row.fast === null || row.slow === null ? `<span class="muted">${t('Swing')} –</span>`
      : `${t('Swing')} <b class="${zone ? 'warn' : ''}">${fixed(row.fast)} / ${fixed(row.slow)}</b>${zone ? ` ${zoneWord(row)}` : ''}`;
    const valueText = value === null ? '' : ` ${t('Cheap/hot')} <b>${value.toFixed(1)}</b> ${valueWord(value)}`;
    setHtml(readout, swingText + valueText);
  }
}
