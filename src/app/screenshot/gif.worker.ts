import { FrameDiffer, GifWriter, PaletteStage, mappedWith, type FrameBody, type Moved } from './gif-encoder.ts';
import { RungController } from './gif-budget.ts';
import type { CodeJob, FromCoordinator, GifStats, PoolToCoordinator, ToCoordinator } from './gif-protocol.ts';

/**
 * The coordinator of a GIF recording, on a thread of its own. Frames come to it as pixels (read back by the pool's workers, in whatever
 * order they finish) and it takes them in order: it compares each with what the viewer sees (`FrameDiffer`), chooses the frame's palette
 * and settings (`PaletteStage`, `RateController`), and hands the pixels to whichever pool worker has least to do. Frames come back coded
 * in whatever order they finish and are written in order (`GifWriter`), which keeps the byte count the rate is judged on and the limit
 * the file never passes. After the last frame it finishes the file at once: nothing is left to do but what is still in the pool.
 */

const scope = self as unknown as { postMessage(message: FromCoordinator, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<ToCoordinator>) => void) | null };
const post = (message: FromCoordinator, transfer: Transferable[] = []): void => scope.postMessage(message, transfer);

type Slot = { kind: 'same' } | { kind: 'busy'; t: number } | { kind: 'body'; t: number; frame: FrameBody } | { kind: 'skipped' };

let width = 0, height = 0, differ: FrameDiffer | null = null, writer: GifWriter | null = null;
const palette = new PaletteStage();
let rate: RungController | null = null;
let ports: MessagePort[] = [];
let load: number[] = [];
const jobWorker = new Map<number, number>();
/** Pixels that arrived ahead of their turn, and what became of the frames that have been taken. */
const waiting = new Map<number, { t: number; rgba: ArrayBuffer }>();
const slots = new Map<number, Slot>();
let nextTake = 0, nextWrite = 0, stopAt: { t: number; count: number } | null = null, full = false, finished = false;
let diffMs = 0, paletteMs = 0, readMs = 0, codeMs = 0, taken = 0, seeded = 0, madePalettes = 0, written = 0;
let levelSum = 0, levelMin = Infinity, levelMax = 0, lastTolerance = 0, postedFps = 0;

function start(m: Extract<ToCoordinator, { type: 'start' }>): void {
  width = m.width; height = m.height;
  differ = new FrameDiffer(width, height); writer = new GifWriter(width, height, m.limit);
  rate = new RungController({ limit: m.limit, total: m.total, rung: m.rung }); postedFps = rate.fps;
  ports = m.ports; load = ports.map(() => 0);
  ports.forEach((port, k) => { port.onmessage = (event: MessageEvent<PoolToCoordinator>): void => fromPool(k, event.data); });
}

function fromPool(k: number, m: PoolToCoordinator): void {
  try {
    if (m.type === 'pixels') { readMs += m.readMs; take(m.seq, m.t, m.rgba); return; }
    load[k] = Math.max(0, load[k]! - 1); codeMs += m.codeMs;
    const slot = slots.get(m.seq);
    if (!slot || slot.kind !== 'busy') return;
    slots.set(m.seq, { kind: 'body', t: slot.t, frame: { body: m.body, transparent: m.transparent } });
    drain();
  } catch (error) { fail(error); }
}

/** A frame's pixels arrived: keep them until it is their turn, then take every frame that can be. */
function take(seq: number, t: number, rgba: ArrayBuffer): void {
  waiting.set(seq, { t, rgba });
  while (waiting.has(nextTake)) {
    const frame = waiting.get(nextTake)!; waiting.delete(nextTake);
    const seqNow = nextTake++;
    if (full || finished) { slots.set(seqNow, { kind: 'skipped' }); continue; }
    process(seqNow, frame.t, frame.rgba);
  }
  drain();
}

function process(seq: number, t: number, rgba: ArrayBuffer): void {
  const r = rate!;
  r.decide(t);
  const settings = r.settings;
  const px = new Uint32Array(rgba, 0, width * height);
  let a = performance.now();
  const moved: Moved = differ!.diff(px, settings.tolerance);
  diffMs += performance.now() - a; taken++;
  levelSum += r.rung; levelMin = Math.min(levelMin, r.rung); levelMax = Math.max(levelMax, r.rung); lastTolerance = settings.tolerance;
  if (moved.changed === 0) { slots.set(seq, { kind: 'same' }); return; }
  a = performance.now();
  const made = palette.make(px, width, moved, settings);
  paletteMs += performance.now() - a; madePalettes++; if (made.seeded) seeded++;
  // The pool worker with the fewest frames to code.
  let k = 0; for (let i = 1; i < load.length; i++) if (load[i]! < load[k]!) k = i;
  load[k]!++;
  slots.set(seq, { kind: 'busy', t });
  const job: CodeJob = { type: 'code', seq, width, rgba, moved, palette: made.colors.rgb, settings: mappedWith(settings, made) };
  ports[k]!.postMessage(job, [rgba]);
}

/** Write what is ready, in order, and keep the rate informed. */
function drain(): void {
  const w = writer!, r = rate!;
  while (slots.has(nextWrite)) {
    const slot = slots.get(nextWrite)!;
    if (slot.kind === 'busy') break;
    slots.delete(nextWrite);
    // A frame taken after the file was full or finished was never decided on: it only counts for the page's tally of frames.
    if (slot.kind === 'skipped') { post({ type: 'progress', seq: nextWrite, frames: w.frames, bytes: w.size, rung: r.rung, fps: r.fps }); nextWrite++; continue; }
    let bytes = 0;
    if (slot.kind === 'body') {
      if (!full) {
        const before = w.size;
        if (w.add(slot.frame, slot.t)) { bytes = w.size - before; written++; }
        else { full = true; post({ type: 'full', t: slot.t }); }
      }
    }
    r.committed(bytes, w.size);
    // The page captures at the rate of the rung the controller is on, so it is told when that changes.
    if (r.fps !== postedFps) { postedFps = r.fps; post({ type: 'rate', fps: r.fps, rung: r.rung }); }
    post({ type: 'progress', seq: nextWrite, frames: w.frames, bytes: w.size, rung: r.rung, fps: r.fps });
    nextWrite++;
  }
  if (stopAt && nextWrite >= stopAt.count && !finished) finish();
}

function finish(): void {
  if (finished || !stopAt) return;
  finished = true;
  const began = performance.now(), w = writer!, r = rate!;
  const bytes = w.finish(stopAt.t);
  const gif = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
  const n = Math.max(1, taken), p = Math.max(1, madePalettes);
  const stats: GifStats = {
    frames: taken, written, bytes: bytes.byteLength, firstBytes: w.firstBytes, duration: w.duration, full,
    fps: r.fps, rung: r.rung, meanRung: levelSum / n, minRung: Number.isFinite(levelMin) ? levelMin : 0, maxRung: levelMax, tolerance: lastTolerance,
    diffMs: diffMs / n, paletteMs: paletteMs / p, readMs: readMs / n, codeMs: codeMs / p, finishMs: performance.now() - began,
    refits: madePalettes - seeded, seededShare: seeded / p,
  };
  post({ type: 'done', gif, stats }, [gif]);
}

function fail(error: unknown): void { post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }

scope.onmessage = (event: MessageEvent<ToCoordinator>): void => {
  const m = event.data;
  try {
    if (m.type === 'start') start(m);
    else if (m.type === 'pixels') take(m.seq, m.t, m.rgba);
    else if (m.type === 'stop') { stopAt = { t: m.t, count: m.count }; drain(); }
  } catch (error) { fail(error); }
};
