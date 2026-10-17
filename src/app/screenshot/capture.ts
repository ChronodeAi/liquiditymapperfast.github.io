/**
 * A picture of the page, drawn by walking it: every canvas is copied at its place, and the boxes, borders and text of the ordinary
 * elements are painted around them. This needs no permission prompt (unlike capturing the screen), cannot taint the canvas (unlike
 * serialising the page into an image) and is exact where it matters, because the chart, the order book and the panes are canvases. The
 * toolbar and pane headers are approximated from their computed styles: boxes, borders, rounded corners, text, gradients, selects and
 * sliders; shadows and pseudo-elements are left out.
 *
 * The same walk serves a moving picture (`paintLayers`): what lies between two canvases is painted once into a layer of its own, and
 * each frame lays the layers and the canvases (as they are by then) over each other in the page's order.
 */
export interface Snapshot { canvas: HTMLCanvasElement; /** Canvas pixels per CSS pixel. */ scale: number; width: number; height: number }
export interface Box { x: number; y: number; w: number; h: number }

const num = (value: string): number => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };

/** The part of `a` inside `b` (null for none); `b` null is no limit. */
export function intersect(a: Box, b: Box | null): Box | null {
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** Split on commas that are not inside parentheses. */
export function splitTop(text: string): string[] {
  const parts: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The first `linear-gradient(...)` of a computed `background-image`, as a canvas gradient over `box`, or null. */
export function gradientFor(ctx: Ctx2D, image: string, box: { x: number; y: number; w: number; h: number }): CanvasGradient | null {
  const start = image.indexOf('linear-gradient('); if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start + 'linear-gradient'.length; i < image.length; i++) { if (image[i] === '(') depth++; else if (image[i] === ')' && --depth === 0) { end = i; break; } }
  if (end < 0) return null;
  const args = splitTop(image.slice(start + 'linear-gradient('.length, end));
  let angle = 180; // CSS default: to bottom
  const first = args[0] ?? '';
  if (/^to /.test(first)) { const dir = first.slice(3).trim(); angle = dir === 'right' ? 90 : dir === 'left' ? 270 : dir === 'top' ? 0 : 180; args.shift(); }
  else if (/deg$/.test(first)) { angle = num(first); args.shift(); }
  const rad = angle * Math.PI / 180, half = (Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad))) / 2;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, dx = Math.sin(rad) * half, dy = -Math.cos(rad) * half;
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  args.forEach((stop, i) => {
    const m = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop); if (!m) return;
    const at = m[2] !== undefined ? Math.max(0, Math.min(1, num(m[2]) / 100)) : (args.length > 1 ? i / (args.length - 1) : 0);
    try { gradient.addColorStop(at, m[1]!.trim()); } catch { /* an unparsable colour is skipped */ }
  });
  return gradient;
}

function roundedPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radii: number[]): void {
  ctx.beginPath();
  if (radii.some(r => r > 0) && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radii.map(r => Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h);
}

function paintBox(ctx: Ctx2D, rect: DOMRect, cs: CSSStyleDeclaration): void {
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(num);
  const box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.fillStyle = cs.backgroundColor; ctx.fill(); }
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    const gradient = gradientFor(ctx, cs.backgroundImage, box);
    if (gradient) { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.fillStyle = gradient; ctx.fill(); }
  }
  const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(num);
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  const drawn = widths.map((w, i) => w > 0 && styles[i] !== 'none' && styles[i] !== 'hidden');
  if (drawn.every(Boolean) && widths.every(w => w === widths[0]) && colors.every(c => c === colors[0])) {
    const w = widths[0]!; roundedPath(ctx, box.x + w / 2, box.y + w / 2, box.w - w, box.h - w, radii.map(r => Math.max(0, r - w / 2)));
    ctx.strokeStyle = colors[0]!; ctx.lineWidth = w; ctx.setLineDash(styles[0] === 'dashed' ? [4, 3] : styles[0] === 'dotted' ? [1, 2] : []); ctx.stroke(); ctx.setLineDash([]);
  } else {
    const side = (i: number, x1: number, y1: number, x2: number, y2: number): void => { if (!drawn[i]) return; ctx.strokeStyle = colors[i]!; ctx.lineWidth = widths[i]!; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    side(0, box.x, box.y + widths[0]! / 2, box.x + box.w, box.y + widths[0]! / 2);
    side(1, box.x + box.w - widths[1]! / 2, box.y, box.x + box.w - widths[1]! / 2, box.y + box.h);
    side(2, box.x, box.y + box.h - widths[2]! / 2, box.x + box.w, box.y + box.h - widths[2]! / 2);
    side(3, box.x + widths[3]! / 2, box.y, box.x + widths[3]! / 2, box.y + box.h);
  }
}

const fontOf = (cs: CSSStyleDeclaration): string => `${cs.fontStyle === 'normal' ? '' : `${cs.fontStyle} `}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

function paintControl(ctx: Ctx2D, node: Element, rect: DOMRect, cs: CSSStyleDeclaration): void {
  const pad = num(cs.paddingLeft) + num(cs.borderLeftWidth);
  ctx.font = fontOf(cs); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (node instanceof HTMLSelectElement) {
    ctx.fillText(node.selectedOptions[0]?.text ?? '', rect.left + pad, rect.top + rect.height / 2 + 0.5, Math.max(0, rect.width - pad - 22));
    ctx.strokeStyle = cs.color; ctx.lineWidth = 1.3; ctx.beginPath();
    ctx.moveTo(rect.right - 14, rect.top + rect.height / 2 - 2); ctx.lineTo(rect.right - 10.5, rect.top + rect.height / 2 + 1.5); ctx.lineTo(rect.right - 7, rect.top + rect.height / 2 - 2); ctx.stroke();
  } else if (node instanceof HTMLInputElement) {
    if (node.type === 'range') {
      const min = num(node.min || '0'), max = num(node.max || '100'), at = max > min ? (num(node.value) - min) / (max - min) : 0;
      const y = rect.top + rect.height / 2, x0 = rect.left + 6, x1 = rect.right - 6;
      ctx.strokeStyle = 'rgba(128,128,128,.55)'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : cs.color; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * at, y, 5.5, 0, Math.PI * 2); ctx.fill();
    } else if (node.type === 'checkbox') {
      ctx.strokeStyle = cs.color; ctx.lineWidth = 1.2; ctx.strokeRect(rect.left + 1.5, rect.top + 1.5, rect.width - 3, rect.height - 3);
      if (node.checked) { ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(rect.left + 3.5, rect.top + rect.height / 2); ctx.lineTo(rect.left + rect.width * 0.42, rect.bottom - 4); ctx.lineTo(rect.right - 3.5, rect.top + 4); ctx.stroke(); }
    } else if (node.value) ctx.fillText(node.value, rect.left + pad, rect.top + rect.height / 2 + 0.5, Math.max(0, rect.width - 2 * pad));
  }
}

/**
 * Where a walk paints: `ctx` is where boxes and text go now (asked only for something that shows in `view`), `canvas` takes a canvas
 * element where it lies, with the opacity and the clip it is seen through.
 */
interface Painter {
  view: Box;
  ctx(): Ctx2D;
  canvas(node: HTMLCanvasElement, rect: Box, alpha: number, clip: Box | null): void;
}

/** Paint with the walk's opacity and clip, then put the context back as it was. */
function inState(ctx: Ctx2D, alpha: number, clip: Box | null, paint: () => void): void {
  ctx.save(); ctx.globalAlpha = alpha;
  if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
  paint();
  ctx.restore();
}

function paintText(painter: Painter, node: Text, cs: CSSStyleDeclaration, alpha: number, clip: Box | null): void {
  const data = node.data; if (!data.trim()) return;
  const view = intersect(painter.view, clip); if (!view) return;
  const transform = cs.textTransform, range = document.createRange();
  let ctx: Ctx2D | null = null;
  for (const match of data.matchAll(/\S+/g)) {
    range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
    const rect = range.getBoundingClientRect(); if (rect.width === 0 && rect.height === 0) continue;
    if (!intersect(boxOf(rect), view)) continue;
    if (!ctx) {
      ctx = painter.ctx(); ctx.save(); ctx.globalAlpha = alpha;
      if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
      ctx.font = fontOf(cs); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    }
    let word = match[0]; if (transform === 'uppercase') word = word.toUpperCase(); else if (transform === 'lowercase') word = word.toLowerCase();
    ctx.fillText(word, rect.left, rect.top + rect.height / 2 + 0.5);
  }
  ctx?.restore();
}

/**
 * A positioned element with a z-index above 0: the page paints it over everything else in its stacking context, wherever it sits in the
 * tree (the bars over the glass: the glass is a z-index 50 child of the body, the bars 52 deep inside it), so it is kept and painted
 * there, after the rest.
 */
interface Raised { node: Element; cs: CSSStyleDeclaration; z: number; order: number; alpha: number; clip: Box | null }
let raisedOrder = 0;

/** Whether an element starts a stacking context of its own (the cases this page uses). */
const stacks = (cs: CSSStyleDeclaration): boolean => (cs.position !== 'static' && cs.zIndex !== 'auto') || num(cs.opacity) < 1 || cs.transform !== 'none' || cs.filter !== 'none' || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal';
const zOf = (cs: CSSStyleDeclaration): number => cs.position !== 'static' && cs.zIndex !== 'auto' ? num(cs.zIndex) : 0;

function paintRaised(painter: Painter, raised: Raised[]): void {
  for (const r of [...raised].sort((p, q) => p.z - q.z || p.order - q.order)) paintNode(painter, r.node, r.alpha, r.clip, [], r.cs);
}

function paintNode(painter: Painter, node: Element, alpha: number, clip: Box | null, raised: Raised[], cs: CSSStyleDeclaration = getComputedStyle(node)): void {
  if (cs.display === 'none' || cs.visibility === 'hidden' || node.hasAttribute('data-no-capture')) return;
  const opacity = num(cs.opacity); if (opacity <= 0) return;
  const rect = node.getBoundingClientRect(), box = boxOf(rect);
  const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  // Nothing of a clipping box outside the view can show, and neither can any of its children.
  if (clips && !intersect(box, intersect(painter.view, clip))) return;
  const a = alpha * opacity;
  let inner = clip;
  if (rect.width > 0 && rect.height > 0) {
    const shows = intersect(box, intersect(painter.view, clip)) !== null;
    if (shows) {
      inState(painter.ctx(), a, clip, () => {
        paintBox(painter.ctx(), rect, cs);
        if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement) paintControl(painter.ctx(), node, rect, cs);
      });
      if (node instanceof HTMLCanvasElement && node.width > 0 && node.height > 0) painter.canvas(node, box, a, clip);
    }
    if (clips) inner = intersect(box, clip) ?? box;
  }
  if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement || node instanceof HTMLCanvasElement) return;
  // Children with a z-index above 0 wait for the end of the stacking context they belong to (this one, if it starts one); those below 0
  // come first, the rest in the order of the page.
  const own = stacks(cs) ? [] as Raised[] : raised;
  const items: { child: Node; cs: CSSStyleDeclaration | null; z: number; i: number }[] = [];
  node.childNodes.forEach((child, i) => {
    if (child instanceof Element) { const c = getComputedStyle(child), z = zOf(c); if (z > 0) own.push({ node: child, cs: c, z, order: raisedOrder++, alpha: a, clip: inner }); else items.push({ child, cs: c, z, i }); }
    else if (child instanceof Text) items.push({ child, cs: null, z: 0, i });
  });
  items.sort((p, q) => p.z - q.z || p.i - q.i);
  for (const { child, cs: c } of items) {
    if (child instanceof Element) paintNode(painter, child, a, inner, own, c!);
    else if (child instanceof Text) paintText(painter, child, cs, a, inner);
  }
  if (own !== raised) paintRaised(painter, own);
}

/** Elements of the page that are never in its picture: the screenshot tool itself, its notices and tooltips. */
const LEFT_OUT = '.shot, .shot-stage, .shot-toast, .tip';

function walk(painter: Painter, root: HTMLElement): void {
  const raised: Raised[] = [];
  for (const child of root.children) {
    if (child.matches(LEFT_OUT)) continue;
    const cs = getComputedStyle(child), z = zOf(cs);
    if (z > 0) raised.push({ node: child, cs, z, order: raisedOrder++, alpha: 1, clip: null }); else paintNode(painter, child, 1, null, raised, cs);
  }
  paintRaised(painter, raised);
}

/** Draw the page as it is on screen now. Open panels and dialogs are included; tooltips are not (they are hidden by the click that started this). */
export function capturePage(root: HTMLElement = document.body): Snapshot {
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  walk({
    view: { x: 0, y: 0, w: width, h: height },
    ctx: () => ctx,
    canvas: (node, rect, alpha, clip) => inState(ctx, alpha, clip, () => { try { ctx.drawImage(node, rect.x, rect.y, rect.w, rect.h); } catch { /* a tainted or lost canvas is skipped */ } }),
  }, root);
  return { canvas, scale, width, height };
}

/** A canvas a moving picture copies each frame: where it lies on the page (CSS px), and the opacity and clip it is seen through. */
export interface LiveCanvas { kind: 'canvas'; node: HTMLCanvasElement; rect: Box; alpha: number; clip: Box | null }
/** What lies between two canvases, painted once for the area. */
export interface StillLayer { kind: 'still'; image: HTMLCanvasElement | OffscreenCanvas }
export type Layer = LiveCanvas | StillLayer;

/** A canvas for a picture `w` × `h`, off the page where the browser has them. */
export function surface(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/** The 2D context of a canvas on or off the page. */
export function context2d(c: HTMLCanvasElement | OffscreenCanvas, options?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = c instanceof HTMLCanvasElement ? c.getContext('2d', options) : c.getContext('2d', options);
  if (!ctx) throw new Error('no 2D canvas');
  return ctx;
}

/**
 * The page in `area` (CSS px) as layers at `scale` picture pixels per CSS pixel, in the page's order: the still parts (boxes, borders,
 * text, controls) painted now, the canvases named so a frame can copy them as they are then. The first layer holds the page's background.
 */
export function paintLayers(area: Box, scale: number, root: HTMLElement = document.body): Layer[] {
  const w = Math.max(1, Math.round(area.w * scale)), h = Math.max(1, Math.round(area.h * scale));
  const layers: Layer[] = [];
  let current: Ctx2D | null = null;
  const open = (): Ctx2D => {
    if (current) return current;
    const image = surface(w, h), ctx = context2d(image);
    ctx.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);
    layers.push({ kind: 'still', image }); current = ctx;
    return ctx;
  };
  const base = open();
  base.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; base.fillRect(area.x, area.y, area.w, area.h);
  walk({
    view: area,
    ctx: open,
    canvas: (node, rect, alpha, clip) => { if (intersect(rect, intersect(area, clip))) { layers.push({ kind: 'canvas', node, rect, alpha, clip }); current = null; } },
  }, root);
  return layers;
}
