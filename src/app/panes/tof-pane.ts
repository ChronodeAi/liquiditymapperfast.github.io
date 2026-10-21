import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { pageNow } from '../replay/clock.ts';
import { bandOf, TOF_TOXIC, TOF_WINDOW, type TofBand } from '../tof/model.ts';
import { readingText } from '../tof/lines.ts';
import type { TofBook, TofModel, TofRow } from '../tof/book.ts';
import type { TofSettings } from '../tof/settings.ts';

/** One colour per venue, apart from the buy and sell colours: Binance's yellow, Bybit's purple. */
const LINE_COLORS: Readonly<Record<string, string>> = { binance: '#d4a106', bybit: '#a855f7' };
/** The candles whose total is a burst are shaded amber, the elevated ones lighter: amber is neither side's colour. */
const BAND_FILL: Partial<Record<TofBand, string>> = { toxic: 'rgba(245,165,36,0.30)', elevated: 'rgba(245,165,36,0.12)' };

/** The popup of one candle: each venue's reading, how it stands against the venue's own last candles, and which side took more. */
export function tofCardLines(row: TofRow, ids: readonly string[], tf: string): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${t('Toxic flow')} · ${tf}`, bold: true }, { label: t('Candle'), text: clock(row.candle.t, true) }];
  ids.forEach((id, i) => {
    const cell = row.cells[i] ?? null;
    lines.push({ label: venueLabel(id), text: cell ? readingText(cell.tof, cell.usual, cell.z) : t('nothing recorded'), mark: id, rule: i === 0 });
    if (cell && cell.buy + cell.sell > 0) {
      const buyers = cell.buy / (cell.buy + cell.sell);
      lines.push({ label: t('Taker buys'), text: `${Math.round(buyers * 100)} %`, color: buyers > 0.55 ? 'buy' : buyers < 0.45 ? 'sell' : 'text' });
    }
  });
  if (ids.length > 1) lines.push({ label: t('Together'), text: readingText(row.total, row.usual, row.z), rule: true });
  lines.push({ text: t('Each venue\'s taker volume in the candle, weighted by how far price went in it, against its own last {n} candles. Above z 2 is a toxic burst: it says how hard the market was hit, not which way it goes next.', { n: String(TOF_WINDOW) }), color: 'muted', wrap: true, rule: true });
  return lines;
}

/**
 * The TOF pane: for each candle of the chart's timeframe, each venue's toxic flow (tof/model.ts) as a line, Binance's and Bybit's perpetuals
 * of the coin where the page records them, and the candles whose total is a toxic burst (z above 2) shaded, the elevated ones (z from 1)
 * lighter; a venue's own burst is a dot on its line. Its header sets what it draws on the map: the levels the candles leave and the
 * untapped ones' reading by price (tof/settings.ts). Needs the chart's own candles: their range weighs the volume.
 */
export class TofPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #sync: (() => void)[] = [];

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub, private book: TofBook) {
    super(host, store, view, 'tof');
    this.head.innerHTML = `<strong>TOF</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('tofPane'));
    setTip(this.head.querySelector('strong')!, t('Toxic flow: how hard takers hit each exchange in each candle, against its own recent candles.'));
    const s = (): TofSettings => this.store.state.tof;
    const patch = (change: Partial<TofSettings>): void => this.store.set({ tof: { ...s(), ...change } });
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    const box = (label: string, title: string, get: () => boolean, set: (on: boolean) => void): void => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title);
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = get(); check.onchange = () => set(check.checked);
      wrap.append(check, label); group.append(wrap);
      this.#sync.push(() => { check.checked = get(); });
    };
    box(t('Levels'), t('On the map: a dot at the open of each candle, sized by its reading, until price trades back through it.'), () => s().levels, levels => patch({ levels }));
    const from = document.createElement('label'); from.className = 'ctl'; setTip(from, t('Which candles leave a level: every candle, those from elevated (z 1), or toxic bursts only (z above 2).')); from.append(t('From'));
    const select = document.createElement('select');
    for (const [value, text] of [['all', t('Every candle')], ['elevated', t('Elevated')], ['toxic', t('Toxic')]] as const) select.append(new Option(text, value));
    select.value = s().from; select.onchange = () => patch({ from: select.value === 'elevated' || select.value === 'toxic' ? select.value : 'all' });
    from.append(select); group.append(from);
    this.#sync.push(() => { if (select.value !== s().from) select.value = s().from; });
    box(t('Taken'), t('Also the levels price has since traded back through, faint: the untapped ones are those whose move went on, so these show what the others leave out.'), () => s().taken, taken => patch({ taken }));
    box(t('By price'), t('Along the right edge of the map: the untapped levels\' reading added up by price.'), () => s().histogram, histogram => patch({ histogram }));
  }

  /** Reflect the settings in the header and draw again. */
  settingsChanged(): void { for (const sync of this.#sync) sync(); this.invalidate(); }

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
    const model: TofModel | null = this.book.model(state, this.hub, v.t0, v.t1, now);
    const say = (text: string): void => { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, 12, ph / 2); setHtml(readout, ''); };
    if (!model) { say(state.seriesInstrument !== state.marketId ? t('Needs the chart\'s own candles: their range weighs the volume.') : t('No Binance or Bybit perpetual of this coin is listed.')); return; }
    const rows = model.rows.filter(r => r.candle.t + tf >= v.t0 && r.candle.t <= v.t1);
    if (!rows.some(r => r.cells.some(c => c?.tof !== null && c?.tof !== undefined))) {
      say(model.earliest === null ? t('No flow recorded for these candles yet.') : t('Flow is recorded from {time}: the candles before it have none.', { time: clock(model.earliest, true) }));
      return;
    }
    let max = 0;
    for (const r of rows) for (const c of r.cells) if (c?.tof && c.tof > max) max = c.tof;
    const top = 8, bottom = ph - 6, y = (value: number): number => bottom - value / (max * 1.08 || 1) * (bottom - top);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // The candles whose total is a burst, shaded across the pane.
    for (const r of rows) {
      const fill = BAND_FILL[bandOf(r.z) ?? 'normal']; if (!fill) continue;
      const x0 = v.xOf(r.candle.t, pw), x1 = v.xOf(r.candle.t + tf, pw);
      ctx.fillStyle = fill; ctx.fillRect(Math.floor(x0), 0, Math.max(1, Math.ceil(x1 - x0)), ph);
    }
    const ends: { id: string; x: number; y: number }[] = [];
    model.ids.forEach((id, i) => {
      const color = LINE_COLORS[id.split(':')[0]!] ?? p.text;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      let drawing = false, last: { x: number; y: number } | null = null;
      for (const r of rows) {
        const c = r.cells[i]; if (!c || c.tof === null) { drawing = false; continue; }
        const x = v.xOf(r.candle.t + tf / 2, pw), yy = y(c.tof);
        if (drawing) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
        drawing = true; last = { x, y: yy };
      }
      ctx.stroke(); ctx.lineWidth = 1;
      // A venue's own bursts: a dot on its line.
      ctx.fillStyle = color;
      for (const r of rows) { const c = r.cells[i]; if (c && c.tof !== null && c.z !== null && c.z > TOF_TOXIC) { ctx.beginPath(); ctx.arc(v.xOf(r.candle.t + tf / 2, pw), y(c.tof), 3, 0, Math.PI * 2); ctx.fill(); } }
      if (last) ends.push({ id, ...last });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 14 && Math.abs(ends[i]!.x - ends[i - 1]!.x) < 14) ends[i]!.y = ends[i - 1]!.y + 14;
    for (const e of ends) drawVenueMark(ctx, e.id, Math.min(pw - 8, e.x + 8), Math.max(top + 6, Math.min(bottom - 6, e.y)), 12);
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    ctx.fillText(`$${usd(max)}`, this.w - AXIS_W + 6, y(max)); ctx.fillText('0', this.w - AXIS_W + 6, bottom);
    // Readout and popup: the candle under the pointer, else the newest in view.
    const time = state.hover ? state.hover.t : Math.min(now, v.t1);
    const row = [...rows].reverse().find(r => r.candle.t <= time) ?? rows[rows.length - 1]!;
    if (state.hover && this.pointer) this.#lines = tofCardLines(row, model.ids, state.timeframe);
    const parts = model.ids.map((id, i) => {
      const c = row.cells[i], band = bandOf(c?.z ?? null);
      return c && c.tof !== null ? `${venueLabel(id)} <b class="${band === 'toxic' ? 'warn' : ''}">$${usd(c.tof)}${c.z !== null ? ` z ${c.z.toFixed(1)}` : ''}</b>` : `<span class="muted">${venueLabel(id)} –</span>`;
    });
    setHtml(readout, parts.join(' '));
  }
}
