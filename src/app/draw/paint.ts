import { t } from '../i18n.ts';
import { price as fmtPrice, usd } from '../format.ts';
import type { Palette } from '../theme.ts';
import type { KeyTag } from '../keylevels/paint.ts';
import { ANCHORS, newDrawing, type DrawColor, type Drawing } from './model.ts';
import { channelLines, extendSegment, fibLevels, handlesOf, noteBox, strokesOf, type Projection, type Segment } from './geometry.ts';
import type { DrawController } from './controller.ts';
import type { SnapField } from './magnet.ts';

/**
 * How the drawings look on the map (draw/controller.ts holds them): every stroke over a halo in the background's own tone, so it reads over
 * bright heat as the candles do; a zone and a channel lightly filled, so the heat shows through. The committed drawings are drawn on the
 * map's own canvas (a screenshot shows them); what belongs to editing (the selection's handles, the pointer's highlight, the drawing being
 * placed, the magnet's catch) on a canvas of its own above it, which a screenshot leaves out.
 */

const AMBER = '#f5a524';
/** A colour role on this theme: the text's, a blue and an amber that read on every background, the point of control's purple, buy, sell. */
export function colorOf(c: DrawColor, p: Palette): string {
  switch (c) {
    case 'ink': return p.text;
    case 'blue': return p.dark ? '#5aa2ff' : '#1f5fd1';
    case 'amber': return AMBER;
    case 'purple': return p.poc;
    case 'bid': return p.bid;
    case 'ask': return p.ask;
  }
}

const FONT = '600 11px ui-sans-serif, system-ui, sans-serif', NOTE_FONT = '12px ui-sans-serif, system-ui, sans-serif';
/** A note's text is cut into lines this wide (px), at most this many. */
const NOTE_W = 220, NOTE_LINES = 4;

const halo = (p: Palette): string => p.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)';

function strokeSegments(ctx: CanvasRenderingContext2D, segs: readonly Segment[], color: string, width: number, dashed: boolean, p: Palette, alpha = 1): void {
  if (!segs.length) return;
  const path = (): void => { ctx.beginPath(); for (const s of segs) { ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); } };
  ctx.save();
  ctx.globalAlpha = alpha * 0.9; ctx.strokeStyle = halo(p); ctx.lineWidth = width + 3; ctx.setLineDash([]); path(); ctx.stroke();
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dashed ? [6, 4] : []); path(); ctx.stroke();
  ctx.restore();
}

/** Text over a small plate in the background's tone, so it reads over the heat; `align` places it left, right or centred on `x`. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, p: Palette, align: CanvasTextAlign = 'left', alpha = 1): void {
  ctx.save();
  ctx.font = FONT; ctx.textBaseline = 'middle'; ctx.textAlign = align;
  const w = ctx.measureText(text).width, x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  ctx.globalAlpha = 0.82 * alpha; ctx.fillStyle = p.panel; ctx.fillRect(x0 - 3, y - 8, w + 6, 16);
  ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.restore();
}

/** A note's lines: the text cut at words to fit `NOTE_W`, at most `NOTE_LINES` (the last ends with an ellipsis when there is more). */
export function noteLines(ctx: CanvasRenderingContext2D, text: string): string[] {
  ctx.save(); ctx.font = NOTE_FONT;
  const words = (text.trim() || t('Note')).split(/\s+/), lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= NOTE_W || !line) line = next; else { lines.push(line); line = word; }
    if (lines.length === NOTE_LINES) break;
  }
  if (lines.length < NOTE_LINES && line) lines.push(line);
  else if (line && lines.length === NOTE_LINES) lines[NOTE_LINES - 1] = `${lines[NOTE_LINES - 1]}…`;
  for (let i = 0; i < lines.length; i++) while (ctx.measureText(lines[i]!).width > NOTE_W && lines[i]!.length > 1) lines[i] = `${lines[i]!.slice(0, -2)}…`;
  ctx.restore();
  return lines;
}

/** The size of a note's text box. */
export function noteSizeOf(ctx: CanvasRenderingContext2D, d: Drawing): { w: number; h: number } {
  const lines = noteLines(ctx, d.text);
  ctx.save(); ctx.font = NOTE_FONT;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 14;
  ctx.restore();
  return { w, h: lines.length * 15 + 8 };
}

/** A small bell, for a level that sounds when the price reaches it. */
function bell(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.save(); ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(x - 4, y + 3); ctx.quadraticCurveTo(x - 4, y - 5, x, y - 5); ctx.quadraticCurveTo(x + 4, y - 5, x + 4, y + 3); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 5, y + 2.5, 10, 1.5); ctx.beginPath(); ctx.arc(x, y + 5, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** One drawing, as it looks committed (`alpha` below 1: the one being placed). */
export function paintDrawing(ctx: CanvasRenderingContext2D, d: Drawing, pr: Projection, p: Palette, alpha = 1): void {
  const color = colorOf(d.style.color, p), w = d.style.width, dash = d.style.dashed;
  switch (d.kind) {
    case 'level': {
      const y = pr.y(d.points[0]!.p);
      strokeSegments(ctx, strokesOf(d, pr), color, w, dash, p, alpha);
      if (d.alert) bell(ctx, pr.w - 10, y - 9, color);
      if (d.text) label(ctx, d.text, pr.w - (d.alert ? 20 : 6), y - 10, color, p, 'right', alpha);
      return;
    }
    case 'vline': {
      strokeSegments(ctx, strokesOf(d, pr), color, w, dash, p, alpha);
      if (d.text) label(ctx, d.text, pr.x(d.points[0]!.t) + 5, 14, color, p, 'left', alpha);
      return;
    }
    case 'trend': {
      const segs = strokesOf(d, pr);
      strokeSegments(ctx, segs, color, w, dash, p, alpha);
      if (d.text && segs[0]) { const a = { x: pr.x(d.points[0]!.t), y: pr.y(d.points[0]!.p) }, b = { x: pr.x(d.points[1]!.t), y: pr.y(d.points[1]!.p) }; label(ctx, d.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, color, p, 'center', alpha); }
      return;
    }
    case 'zone': {
      const [a, b] = d.points;
      const x0 = Math.min(pr.x(a!.t), pr.x(b!.t)), x1 = d.extendRight ? pr.w : Math.max(pr.x(a!.t), pr.x(b!.t)), y0 = Math.min(pr.y(a!.p), pr.y(b!.p)), y1 = Math.max(pr.y(a!.p), pr.y(b!.p));
      ctx.save(); ctx.globalAlpha = 0.13 * alpha; ctx.fillStyle = color; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.restore();
      strokeSegments(ctx, strokesOf(d, pr), color, w, dash, p, alpha);
      if (d.text) label(ctx, d.text, Math.max(x0, 0) + 6, y0 + 10, color, p, 'left', alpha);
      return;
    }
    case 'fib': {
      const levels = fibLevels(d, pr), [a, b] = d.points;
      ctx.save();
      for (let i = 0; i + 1 < levels.length; i++) { const l = levels[i]!, n = levels[i + 1]!; ctx.globalAlpha = (i % 2 ? 0.035 : 0.06) * alpha; ctx.fillStyle = color; ctx.fillRect(l.x0, Math.min(l.y, n.y), l.x1 - l.x0, Math.abs(n.y - l.y)); }
      ctx.restore();
      strokeSegments(ctx, [{ a: { x: pr.x(a!.t), y: pr.y(a!.p) }, b: { x: pr.x(b!.t), y: pr.y(b!.p) } }], color, 1, true, p, alpha * 0.7);
      strokeSegments(ctx, strokesOf(d, pr), color, w, dash, p, alpha);
      for (const l of levels) label(ctx, `${l.ratio} · ${fmtPrice(l.price)}`, Math.max(l.x0, 0) + 4, l.y - 8, color, p, 'left', alpha);
      if (d.text) label(ctx, d.text, (levels[0]!.x0 + levels[0]!.x1) / 2, levels[0]!.y - 22, color, p, 'center', alpha);
      return;
    }
    case 'channel': {
      const { base, parallel } = channelLines(d, pr);
      if (base && parallel) {
        ctx.save(); ctx.globalAlpha = 0.07 * alpha; ctx.fillStyle = color; ctx.beginPath();
        ctx.moveTo(base.a.x, base.a.y); ctx.lineTo(base.b.x, base.b.y); ctx.lineTo(parallel.b.x, parallel.b.y); ctx.lineTo(parallel.a.x, parallel.a.y); ctx.closePath(); ctx.fill(); ctx.restore();
        const mid = extendSegment({ x: (base.a.x + parallel.a.x) / 2, y: (base.a.y + parallel.a.y) / 2 }, { x: (base.b.x + parallel.b.x) / 2, y: (base.b.y + parallel.b.y) / 2 }, false, false, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 });
        if (mid) strokeSegments(ctx, [mid], color, 1, true, p, alpha * 0.6);
      }
      strokeSegments(ctx, strokesOf(d, pr), color, w, dash, p, alpha);
      if (d.text && base) label(ctx, d.text, (base.a.x + base.b.x) / 2, (base.a.y + base.b.y) / 2 - 12, color, p, 'center', alpha);
      return;
    }
    case 'note': {
      const x = pr.x(d.points[0]!.t), y = pr.y(d.points[0]!.p), size = noteSizeOf(ctx, d), box = noteBox(d, pr, size);
      if (d.leader) strokeSegments(ctx, strokesOf(d, pr), color, 1, false, p, alpha);
      ctx.save();
      ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.94 * alpha; ctx.fillStyle = p.panel; ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
      ctx.fillStyle = p.text; ctx.font = NOTE_FONT; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      noteLines(ctx, d.text).forEach((line, i) => ctx.fillText(line, box.x + 7, box.y + 5 + i * 15));
      ctx.restore();
      return;
    }
  }
}

/** Whether a drawing can show on the plot at all (its time span or its price reaches it), so the rest are not drawn. */
function inView(d: Drawing, pr: Projection): boolean {
  if (d.kind === 'level') return pr.y(d.points[0]!.p) >= -2 && pr.y(d.points[0]!.p) <= pr.h + 2 && (d.extendLeft || pr.x(d.points[0]!.t) <= pr.w);
  if (d.kind === 'vline') { const x = pr.x(d.points[0]!.t); return x >= -2 && x <= pr.w + 2; }
  return true;
}

/**
 * The committed drawings on the map's canvas, clipped to the plot; the tags of the levels for the price axis, placed with the key levels'
 * (the person's own come first).
 */
export function paintDrawings(ctx: CanvasRenderingContext2D, draw: DrawController, pr: Projection, p: Palette): KeyTag[] {
  draw.noteSize = d => noteSizeOf(ctx, d);
  const list = draw.shown(), tags: KeyTag[] = [];
  if (!list.length) return tags;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pr.w, pr.h); ctx.clip();
  for (const d of list) {
    if (!inView(d, pr)) continue;
    paintDrawing(ctx, d, pr, p);
    if (d.kind === 'level') tags.push({ key: `draw|${d.id}`, y: pr.y(d.points[0]!.p), rank: -10, text: fmtPrice(d.points[0]!.p), older: false, color: colorOf(d.style.color, p) });
  }
  ctx.restore();
  return tags;
}

const FIELD_WORDS = (): Record<SnapField, string> => ({ open: t('Open'), high: t('High'), low: t('Low'), close: t('Close'), wall: t('Wall') });

/** What belongs to editing, on its own canvas: the hovered drawing lit, the selection's handles, the drawing being placed, the magnet's catch. */
export function paintEditing(ctx: CanvasRenderingContext2D, draw: DrawController, pr: Projection, p: Palette): void {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pr.w, pr.h); ctx.clip();
  const hovered = draw.hover && draw.hover.id !== draw.selected ? draw.get(draw.hover.id) : null;
  if (hovered) strokeSegments(ctx, strokesOf(hovered, pr), colorOf(hovered.style.color, p), hovered.style.width + 3, false, p, 0.3);
  const sel = draw.shown().find(d => d.id === draw.selected);
  if (sel) {
    const color = colorOf(sel.style.color, p);
    strokeSegments(ctx, strokesOf(sel, pr), color, sel.style.width + 4, false, p, 0.22);
    for (const h of handlesOf(sel, pr)) {
      ctx.fillStyle = p.panel; ctx.fillRect(h.x - 4.5, h.y - 4.5, 9, 9);
      ctx.strokeStyle = sel.locked ? p.muted : color; ctx.lineWidth = 1.5; ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
    }
  }
  const draft = draw.draft, cursor = draw.cursor;
  if (draw.tool) {
    const kind = draw.tool, points = [...(draft?.points ?? []), ...(cursor ? [cursor.at] : [])];
    // The drawing as it would be with the next point where the pointer is: the missing points sit on the pointer too.
    if (points.length && (points.length > 1 || ANCHORS[kind] === 1)) {
      while (points.length < ANCHORS[kind]) points.push(points[points.length - 1]!);
      paintDrawing(ctx, newDrawing(kind, points, 0), pr, p, 0.75);
    }
    for (const q of draft?.points ?? []) { ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(pr.x(q.t), kind === 'vline' ? pr.h / 2 : pr.y(q.p), 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  if (cursor?.snap) {
    const s = cursor.snap, words = FIELD_WORDS();
    ctx.strokeStyle = p.text; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cursor.x, cursor.y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(cursor.x, cursor.y, 2, 0, Math.PI * 2); ctx.fill();
    const text = s.field === 'wall' ? `${words.wall} ${usd(s.usd ?? 0)} · ${fmtPrice(s.p)}` : `${words[s.field]} ${fmtPrice(s.p)}`;
    const right = cursor.x > pr.w - 170;
    label(ctx, text, right ? cursor.x - 10 : cursor.x + 10, cursor.y - 14, p.text, p, right ? 'right' : 'left');
  }
  ctx.restore();
}
