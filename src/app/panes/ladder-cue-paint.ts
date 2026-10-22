import { mixHex, type Palette } from '../theme.ts';
import { bodyLight, crestAt, crestLight, markLight, type Cell, type Cue, type CueLook, type Mark } from './ladder-cues.ts';

/**
 * How the cues are drawn on the material canvas (the pane's second canvas, under the words: `ladder-pane.ts`). Everything here is a function of
 * the cue, its cell and its age, so a frame is as good as the one before it and the pane repaints only the cells that are lit.
 *
 * One rule runs through the looks: light follows the material. An addition lights a cell where there is light to add (a dark page) and
 * deepens it where there is none (a light page); a decrease relaxes it toward the panel on both, so the sign is always read from the same
 * thing, more material or less, and never from a colour. The same signed strength and the same envelope drive both. The crest, a thin front
 * through the cell, runs out for an addition and back in for a decrease; it is what lets a decrease be seen where dimming a dark bar barely
 * shows (the Tape's own shock, `candle/trail-gl.ts`, for the same reason).
 */

export interface Box { x: number; y: number; w: number; h: number }

/** The strongest a wash gets: an addition's light, and how far a decrease takes a cell back toward the panel. */
export const WASH_UP = 0.46, WASH_DOWN = 0.62;
/** The crest's width in px, and how far its glow reaches either side of it. */
const CREST_W = 2.2, CREST_GLOW = 3.5;
/** A cell narrower than this has no room for a crest to cross it: its wash alone speaks. */
const CREST_MIN_W = 6;

/** What the pane must restore under a cue: its cell grown by the crest's reach. */
export const cueBox = (cell: Cell): Box => ({ x: cell.x - CREST_GLOW - 1, y: cell.y - 1, w: cell.w + 2 * CREST_GLOW + 2, h: cell.h + 2 });
/** The gutter cell of a row (where its mark is drawn): `x` is the gutter's left edge. */
export const markBox = (x: number, y: number, w: number, rowH: number): Box => ({ x, y, w, h: rowH });

const sideColor = (side: 'bid' | 'ask', p: Palette): string => side === 'ask' ? p.ask : p.bid;

/** The colour an addition's wash lays on its cell: white on a dark page, the side's colour much deeper on a light one. */
export const washUp = (side: 'bid' | 'ask', p: Palette): string => p.dark ? '#ffffff' : mixHex(sideColor(side, p), '#000000', 0.4);
/** The crest of an addition (bright, tinted by its side on a dark page) and of a decrease (the same light, untinted, running the other way). */
export const crestUp = (side: 'bid' | 'ask', p: Palette): string => p.dark ? mixHex(sideColor(side, p), '#ffffff', 0.72) : mixHex(sideColor(side, p), '#000000', 0.55);
export const crestDown = (side: 'bid' | 'ask', p: Palette): string => p.dark ? '#ffffff' : mixHex(sideColor(side, p), '#000000', 0.78);

function lay(m: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number): void {
  if (!(alpha > 0.003) || !(w > 0) || !(h > 0)) return;
  m.globalAlpha = Math.min(1, alpha); m.fillStyle = color; m.fillRect(x, y, w, h); m.globalAlpha = 1;
}

/** The crest: a thin front across the cell, out for an addition and back for a decrease, with a soft glow either side. */
function crest(m: CanvasRenderingContext2D, cue: Cue, cell: Cell, age: number, light: number, p: Palette): void {
  if (!(light > 0.003) || cell.w < CREST_MIN_W) return;
  const up = cue.sign > 0, color = up ? crestUp(cue.side, p) : crestDown(cue.side, p);
  const fx = cell.x + crestAt(cue.sign, age) * cell.w;
  lay(m, fx - CREST_GLOW, cell.y, 2 * CREST_GLOW, cell.h, color, light * 0.22);
  lay(m, fx - CREST_W / 2, cell.y, CREST_W, cell.h, color, light * (up ? 0.95 : 0.8));
}

/** Paint one cue on `m` (the material, in CSS px) at `age` ms. The cell's own fill is already there; the cue is laid over it and nothing else is touched. */
export function paintCue(m: CanvasRenderingContext2D, look: CueLook, cue: Cue, cell: Cell, age: number, p: Palette): void {
  if (look === 'marks') return;
  const a = bodyLight(cue.strength, age), c = crestLight(cue.strength, age);
  if (!(a > 0.002) && !(c > 0.002)) return;
  const { x, y, w, h } = cell, up = cue.sign > 0;
  m.save();
  m.beginPath(); m.rect(x - CREST_GLOW, y, w + 2 * CREST_GLOW, h); m.clip();
  if (look === 'wash') {
    lay(m, x, y, w, h, up ? washUp(cue.side, p) : p.panel, a * (up ? WASH_UP : WASH_DOWN));
    crest(m, cue, cell, age, c, p);
  } else if (look === 'deposit') {
    if (up) {
      // New material fused in at the cell's outer end: the layer the addition made, between the old edge and the new one, glowing and settling.
      const layer = Math.min(w, Math.max(2, cell.usd > 0 ? Math.abs(cue.usd) / cell.usd * w : w * 0.25)), x1 = x + w;
      lay(m, x1 - layer, y, layer, h, washUp(cue.side, p), a * WASH_UP * 1.35);
      lay(m, x1 - layer, y, 1, h, crestUp(cue.side, p), c * 0.7);
      lay(m, x1 - 1.5, y, 1.5, h, crestUp(cue.side, p), c * 0.6);
    } else {
      lay(m, x, y, w, h, p.panel, a * WASH_DOWN * 0.7);
      crest(m, cue, cell, age, c, p);
    }
  } else {
    // rim: the cell's body stays as it is; its outer edge speaks.
    const rim = Math.min(w, 2 + 1.5 * cue.strength), x1 = x + w;
    if (up) lay(m, x1 - rim, y, rim, h, crestUp(cue.side, p), 1.15 * a);
    else { lay(m, x1 - rim, y, rim, h, p.panel, 0.85 * a); lay(m, x1 - rim - 1, y, 1, h, crestDown(cue.side, p), 0.5 * a); }
  }
  m.restore();
}

/**
 * A row's mark in the gutter beside the bars: a triangle, up for an addition and down for a decrease, in the side's colour and as big as the
 * change (a bar for a cell that emptied, a hollow triangle for opposite changes close together), fading over a few seconds. A change that
 * already lit its cell is drawn fainter: the light said it. `still` (reduced motion) holds it at full strength until it goes.
 */
export function paintMark(m: CanvasRenderingContext2D, mark: Mark, box: Box, age: number, p: Palette, still: boolean): void {
  const alpha = still ? 1 : markLight(age) * (mark.lit ? 0.55 : 1);
  if (!(alpha > 0.02)) return;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, s = 2.2 + 2.6 * mark.strength, color = sideColor(mark.side, p);
  m.save(); m.globalAlpha = Math.min(1, alpha); m.fillStyle = color; m.strokeStyle = color; m.lineWidth = 1.3;
  if (mark.removed) { m.fillRect(cx - s, cy - 1, 2 * s, 2); }
  else {
    m.beginPath();
    if (mark.sign > 0) { m.moveTo(cx, cy - s); m.lineTo(cx + s, cy + s * 0.8); m.lineTo(cx - s, cy + s * 0.8); }
    else { m.moveTo(cx, cy + s); m.lineTo(cx + s, cy - s * 0.8); m.lineTo(cx - s, cy - s * 0.8); }
    m.closePath();
    if (mark.pair) m.stroke(); else m.fill();
  }
  m.restore();
}
