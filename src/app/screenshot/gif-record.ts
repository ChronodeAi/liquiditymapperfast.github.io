import { context2d, intersect, paintLayers, surface, type Box, type Ctx2D, type Layer, type LiveCanvas } from './capture.ts';
import { drawShape, paintMark, type Shape } from './shapes.ts';
import { GIF_LIMIT, type GifPlan } from './gif-budget.ts';
import type { Rgb } from './gif-encoder.ts';
import type { FromGifWorker, ToGifWorker } from './gif-protocol.ts';

/**
 * Recording the selected area as a GIF. When it starts, the page in the area is painted once as layers (`paintLayers`: the still parts
 * between canvases), and each frame lays them over the canvases as they are then, cut to the area and at the GIF's size, so a frame costs
 * the page a few image copies on the graphics card. The frame is handed to a worker without a copy (`gif.worker.ts`), which reads it back
 * and encodes it there, so the GIF is ready almost as soon as the recording ends. The still layers are painted again (at most twice a
 * second) when the page's elements in the area change: a readout's text, a lamp, a panel opening.
 *
 * Three canvases are WebGL that does not keep its picture once the screen has shown it (`LIVE_GL`): the glass with its waves, the trade
 * dust and the phone tape's trail. Read from a frame of ours they would come out empty, or as whatever the last draw left, so while
 * recording each one's draws are watched (its context's draw calls, the context itself unchanged), and right after the task that drew
 * it the part of it in the area is copied; a frame takes that copy. The heatmap keeps its picture and is read as any canvas.
 */

/** WebGL canvases that do not keep their picture (`preserveDrawingBuffer` false). A new one must be named here to show in a GIF. */
const LIVE_GL = ['canvas.ui-glass', 'canvas.dust', 'canvas.candle-trail'].join(', ');
/** Frames handed to the worker and not answered yet beyond which a frame is skipped (the next one covers its time). */
const MAX_IN_FLIGHT = 6;
/** How long the start waits for each watched canvas to draw once, so the first frame has it (ms). */
const WARM_MS = 450;
/**
 * The still layers are painted again at most this often while the page's elements change (ms), and less often when painting them takes
 * long: a few ms for a chart, up to 25 for the whole page, which then waits 60 times that between paints.
 */
const REPAINT_MS = 500, REPAINT_SHARE = 60;

export interface GifProgress { elapsed: number; total: number; bytes: number; frames: number; fps: number; starting: boolean }
export interface GifResult {
  blob: Blob; bytes: number; frames: number;
  /** The file's head and first frame (bytes): what the rest is measured against. */
  firstBytes: number;
  /** How long the GIF plays (ms). */
  duration: number;
  /** The frame rate planned, and the one it ended at (lower when the file would have passed the limit). */
  plannedFps: number; fps: number;
  /** The tolerance it ended with (raised when small changes were let go to keep the file small). */
  tolerance: number;
  width: number; height: number;
  /** Why it ended: its length, the person, the size limit, or the page being hidden. */
  ended: 'time' | 'stopped' | 'full' | 'hidden';
  /** The page thread's time per frame (ms, mean and worst), frames skipped while the worker was behind, and the worker's own times. */
  captureMs: number; captureP95Ms: number; captureWorstMs: number; skipped: number; encodeMs: number; readMs: number; finishMs: number; repaints: number; repaintWorstMs: number; refits: number;
}
export interface GifRecording { stop(): void; cancel(): void; done: Promise<GifResult | null> }

export interface GifRequest {
  area: Box;
  seconds: number;
  plan: GifPlan;
  /** The marks drawn on the selection, burnt into every frame. */
  shapes: readonly Shape[];
  /** The address for the corner mark, or null for none. */
  mark: string | null;
  onProgress(progress: GifProgress): void;
}

/** The theme's buy and sell colours, which the waves' light is made of. */
function tints(): { tints: Rgb[]; dark: boolean } {
  const cs = getComputedStyle(document.documentElement), probe = document.createElement('canvas').getContext('2d');
  const parse = (value: string): Rgb | null => {
    if (!probe || !value.trim()) return null;
    probe.fillStyle = '#000'; probe.fillStyle = value.trim();
    const m = /^#([0-9a-f]{6})$/i.exec(String(probe.fillStyle));
    return m ? [parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16)] : null;
  };
  const found = [parse(cs.getPropertyValue('--bid')), parse(cs.getPropertyValue('--ask'))].filter((c): c is Rgb => c !== null);
  const bg = parse(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0];
  return { tints: found, dark: 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 128 };
}

/** Copy the part of a canvas in the area into a frame at `s` GIF pixels per CSS pixel. */
function drawVisible(ctx: Ctx2D, layer: LiveCanvas, area: Box, s: number): void {
  const seen = intersect(layer.rect, intersect(area, layer.clip)), node = layer.node;
  if (!seen || !node.width || !node.height) return;
  const kx = node.width / layer.rect.w, ky = node.height / layer.rect.h;
  try { ctx.drawImage(node, (seen.x - layer.rect.x) * kx, (seen.y - layer.rect.y) * ky, seen.w * kx, seen.h * ky, (seen.x - area.x) * s, (seen.y - area.y) * s, seen.w * s, seen.h * s); }
  catch { /* a lost canvas is left out */ }
}

type DrawCall = 'drawArrays' | 'drawElements' | 'drawArraysInstanced' | 'drawElementsInstanced' | 'drawRangeElements' | 'clear';
const DRAW_CALLS: readonly DrawCall[] = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear'];

/** A WebGL canvas watched while recording: its copy for the area, how many times it has been copied, and the undoing of the watch. */
interface Watch { image: HTMLCanvasElement | OffscreenCanvas; copies: number; release(): void }

/**
 * Watch a WebGL canvas that does not keep its picture: after any task that drew to the screen through its context, copy its part of
 * the area. The watch replaces the context's draw calls on that one context with ones that call them and note the draw, and puts them
 * back when it ends. Null for a canvas that is not one of them (or not drawn yet, or lost): that one is read directly.
 */
function watch(layer: LiveCanvas, area: Box, s: number, w: number, h: number): Watch | null {
  const node = layer.node;
  // Not sized yet means its renderer has not started, and asking for its context would make one with the wrong settings.
  if (!node.matches(LIVE_GL) || (node.width === 300 && node.height === 150)) return null;
  const gl = node.getContext('webgl2');
  if (!gl || gl.isContextLost() || gl.getContextAttributes()?.preserveDrawingBuffer) return null;
  const image = surface(w, h), ctx = context2d(image);
  const own = gl as unknown as Record<string, unknown>;
  let toScreen = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null, queued = false;
  const result: Watch = { image, copies: 0, release: () => {} };
  const copy = (): void => { queued = false; ctx.clearRect(0, 0, w, h); drawVisible(ctx, layer, area, s); result.copies++; };
  const bind = gl.bindFramebuffer.bind(gl);
  own['bindFramebuffer'] = (target: number, framebuffer: WebGLFramebuffer | null): void => { if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) toScreen = framebuffer === null; bind(target, framebuffer); };
  for (const name of DRAW_CALLS) {
    const call = (gl[name] as (...args: unknown[]) => void).bind(gl);
    own[name] = (...args: unknown[]): void => { call(...args); if (toScreen && !queued) { queued = true; queueMicrotask(copy); } };
  }
  result.release = (): void => { for (const name of ['bindFramebuffer', ...DRAW_CALLS]) delete own[name]; };
  return result;
}

export function recordGif(request: GifRequest): GifRecording {
  const { area, plan } = request, s = plan.scale, W = plan.width, H = plan.height, total = Math.round(request.seconds * 1000);
  const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' });
  const bitmaps = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function';
  // Frames go to the reader as pictures and reach the encoder as pixels; without pictures off the page, as pixels straight to the encoder.
  const reader = bitmaps ? new Worker(new URL('./gif-read.worker.ts', import.meta.url), { type: 'module' }) : null;
  if (reader) { const channel = new MessageChannel(); reader.postMessage({ type: 'port', port: channel.port1 } satisfies ToGifWorker, [channel.port1]); worker.postMessage({ type: 'port', port: channel.port2 } satisfies ToGifWorker, [channel.port2]); }
  const frame = bitmaps ? new OffscreenCanvas(W, H) : surface(W, H), fctx = context2d(frame);
  const effects = request.shapes.filter(sh => sh.kind === 'pixelate' || sh.kind === 'blur');
  // The marks that do not read the picture, and the corner mark, are drawn once.
  const overlay = surface(W, H), octx = context2d(overlay);
  octx.save(); octx.translate(-area.x * s, -area.y * s);
  for (const shape of request.shapes) if (shape.kind !== 'pixelate' && shape.kind !== 'blur') drawShape(octx, shape, overlay, s);
  octx.restore();
  if (request.mark) { octx.save(); octx.scale(s, s); paintMark(octx, { x: 0, y: 0, w: area.w, h: area.h }, request.mark); octx.restore(); }

  const watches = new Map<HTMLCanvasElement, Watch>();
  let layers: Layer[] = [], paintMs = 0, paintWorst = 0;
  const paint = (): void => {
    const began = performance.now();
    layers = paintLayers(area, s);
    paintMs = performance.now() - began; if (paintMs > paintWorst) paintWorst = paintMs;
    const seen = new Set<HTMLCanvasElement>();
    for (const layer of layers) if (layer.kind === 'canvas') {
      seen.add(layer.node);
      if (!watches.has(layer.node)) { const w = watch(layer, area, s, W, H); if (w) watches.set(layer.node, w); }
    }
    for (const [node, w] of watches) if (!seen.has(node)) { w.release(); watches.delete(node); }
  };
  paint();

  let dirty = false, repainted = 0, repaints = 0, repaintQueued = false;
  const observer = new MutationObserver(records => {
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!target || target instanceof HTMLCanvasElement || target.closest('.shot, .shot-toast, .tip')) continue;
      dirty = true; return;
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'value', 'data-state', 'open', 'disabled'] });

  const compose = (): void => {
    fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.globalAlpha = 1; fctx.globalCompositeOperation = 'source-over';
    fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = s < 0.75 ? 'medium' : 'low';
    for (const layer of layers) {
      if (layer.kind === 'still') { fctx.drawImage(layer.image, 0, 0); continue; }
      fctx.globalAlpha = layer.alpha;
      const watched = watches.get(layer.node);
      if (watched) fctx.drawImage(watched.image, 0, 0);
      else if (layer.node.isConnected) drawVisible(fctx, layer, area, s);
      fctx.globalAlpha = 1;
    }
    for (const shape of effects) { fctx.save(); fctx.translate(-area.x * s, -area.y * s); drawShape(fctx, shape, frame, s, area); fctx.restore(); }
    fctx.drawImage(overlay, 0, 0);
  };

  let resolve: (result: GifResult | null) => void = () => {};
  const done = new Promise<GifResult | null>(r => { resolve = r; });
  let raf = 0, start = -1, nextAt = 0, interval = 1000 / plan.fps, fps = plan.fps, sent = 0, answered = 0, bytes = 0, frames = 0;
  let ending: GifResult['ended'] | null = null, cancelled = false, finished = false, skipped = 0, captureMs = 0, captureWorst = 0, captured = 0, last = 0;
  const spentAll: number[] = [];

  const send = (message: ToGifWorker, transfer: Transferable[] = []): void => (reader ?? worker).postMessage(message, transfer);
  const terminate = (): void => { worker.terminate(); reader?.terminate(); };
  const cleanup = (): void => {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    observer.disconnect();
    for (const w of watches.values()) w.release(); watches.clear();
    document.removeEventListener('visibilitychange', onHidden);
  };
  const end = (why: GifResult['ended'], t: number): void => {
    if (ending || cancelled) return;
    ending = why; cleanup();
    send({ type: 'stop', t: Math.max(0, Math.min(total, t)) });
  };
  const onHidden = (): void => { if (document.hidden && start >= 0) end('hidden', last); };
  document.addEventListener('visibilitychange', onHidden);

  worker.onmessage = (event: MessageEvent<FromGifWorker>): void => {
    const m = event.data;
    if (m.type === 'progress') { answered++; bytes = m.bytes; frames = m.frames; }
    else if (m.type === 'fps') { fps = m.fps; interval = 1000 / fps; }
    else if (m.type === 'full') end('full', m.t);
    else if (m.type === 'done') {
      finished = true; terminate();
      // No frame came through (pixels could not be read back here): nothing to show.
      if (cancelled || m.frames === 0) { resolve(null); return; }
      resolve({
        blob: new Blob([m.gif], { type: 'image/gif' }), bytes: m.bytes, frames: m.frames, firstBytes: m.firstBytes, duration: m.duration, plannedFps: plan.fps, fps: m.fps, tolerance: m.tolerance,
        width: W, height: H, ended: m.full ? 'full' : ending ?? 'stopped', captureMs: captured ? captureMs / captured : 0, captureWorstMs: captureWorst,
        captureP95Ms: spentAll.length ? spentAll.sort((p, q) => p - q)[Math.floor(spentAll.length * 0.95)]! : 0,
        skipped, encodeMs: m.encodeMs, readMs: m.readMs, finishMs: m.finishMs, repaints, repaintWorstMs: paintWorst, refits: m.refits,
      });
    } else if (m.type === 'error') { console.warn('GIF:', m.message); cancelled = true; cleanup(); terminate(); resolve(null); }
  };
  const failed = (event: ErrorEvent): void => { console.warn('GIF: the encoder did not start.', event.message); cancelled = true; cleanup(); terminate(); resolve(null); };
  worker.onerror = failed; if (reader) reader.onerror = failed;
  const { tints: colours, dark } = tints();
  send({ type: 'start', width: W, height: H, colors: plan.colors, dither: plan.dither, tolerance: plan.tolerance, limit: GIF_LIMIT, tints: colours, dark, fps: plan.fps, total });

  const tick = (now: number): void => {
    raf = 0;
    if (ending || cancelled) return;
    raf = requestAnimationFrame(tick);
    if (start < 0) {
      // Wait for the watched canvases to draw once (the glass draws when the page's top level changes, so it is nudged), or not long.
      if (nextAt === 0) { nextAt = now + WARM_MS; const nudge = document.createElement('i'); document.body.append(nudge); nudge.remove(); }
      if (now < nextAt && [...watches.values()].some(w => w.copies === 0)) { request.onProgress({ elapsed: 0, total, bytes: 0, frames: 0, fps, starting: true }); return; }
      start = now; nextAt = now;
    }
    const t = now - start;
    if (t >= total) { end('time', total); return; }
    // A frame a little before its time is taken: the display's frames do not fall exactly on the GIF's.
    if (now < nextAt - interval * 0.25) return;
    nextAt = Math.max(nextAt + interval, now - interval);
    if (sent - answered >= MAX_IN_FLIGHT) { skipped++; return; }
    const began = performance.now();
    compose();
    if (bitmaps && frame instanceof OffscreenCanvas) { const bitmap = frame.transferToImageBitmap(); send({ type: 'frame', t, bitmap }, [bitmap]); }
    else { const data = fctx.getImageData(0, 0, W, H).data; send({ type: 'frame', t, rgba: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]); }
    sent++; last = t;
    const spent = performance.now() - began; captureMs += spent; captured++; if (spent > captureWorst) captureWorst = spent; spentAll.push(spent);
    // The still parts are painted again after this frame has gone to the screen, when the page has a moment.
    if (dirty && !repaintQueued && now - repainted >= Math.max(REPAINT_MS, paintMs * REPAINT_SHARE)) {
      dirty = false; repainted = now; repaintQueued = true;
      const run = (): void => { repaintQueued = false; if (ending || cancelled) return; paint(); repaints++; };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 250 }); else window.setTimeout(run, 0);
    }
    request.onProgress({ elapsed: t, total, bytes, frames, fps, starting: false });
  };
  raf = requestAnimationFrame(tick);

  return {
    stop: () => { if (start < 0) { cancelled = true; cleanup(); terminate(); resolve(null); return; } end('stopped', last + interval); },
    cancel: () => { if (finished) return; cancelled = true; cleanup(); terminate(); resolve(null); },
    done,
  };
}
