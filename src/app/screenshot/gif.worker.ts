import { GifEncoder } from './gif-encoder.ts';
import { adaptRate, type Rate } from './gif-budget.ts';
import type { FromGifWorker, ToGifWorker } from './gif-protocol.ts';

/**
 * The GIF encoder on its own thread: frames arrive as they are captured (as pixels from the reader, `gif-read.worker.ts`, through the
 * port the page joined them with; or as pictures read back here where there is no reader), each is written as soon as the next shows
 * how long it lasts, and the file is handed back when the recording ends. Once a second it judges from the bytes so far whether the
 * frame rate must come down to stay under the limit.
 */

const scope = self as unknown as { postMessage(message: FromGifWorker, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<ToGifWorker>) => void) | null };
const post = (message: FromGifWorker, transfer: Transferable[] = []): void => scope.postMessage(message, transfer);

let encoder: GifEncoder | null = null;
let reader: OffscreenCanvasRenderingContext2D | null = null;
let rate: Rate = { fps: 30, tolerance: 0 }, total = 0, judged = 0, encodeMs = 0, readMs = 0, full = false;

function pixels(message: Extract<ToGifWorker, { type: 'frame' }>, width: number, height: number): Uint8ClampedArray | null {
  if ('rgba' in message) { readMs += message.readMs ?? 0; return message.rgba.byteLength === width * height * 4 ? new Uint8ClampedArray(message.rgba) : null; }
  const bitmap = message.bitmap;
  try {
    if (!reader) {
      reader = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true, alpha: false });
      if (!reader) return null;
      reader.globalCompositeOperation = 'copy';
    }
    reader.drawImage(bitmap, 0, 0);
    return reader.getImageData(0, 0, width, height).data;
  } finally { bitmap.close(); }
}

function handle(event: MessageEvent<ToGifWorker>): void {
  const m = event.data;
  try {
    if (m.type === 'port') { m.port.onmessage = handle; return; }
    if (m.type === 'start') {
      encoder = new GifEncoder({ width: m.width, height: m.height, colors: m.colors, dither: m.dither, tolerance: m.tolerance, limit: m.limit, tints: m.tints, dark: m.dark, paletteFrames: 3 });
      rate = { fps: m.fps, tolerance: m.tolerance }; total = m.total; judged = 0; encodeMs = 0; readMs = 0; full = false; reader = null;
      return;
    }
    if (!encoder) { if (m.type === 'frame' && 'bitmap' in m) m.bitmap.close(); return; }
    if (m.type === 'frame') {
      const started = performance.now();
      if (encoder.full) { if ('bitmap' in m) m.bitmap.close(); }
      else {
        const read = performance.now(), rgba = pixels(m, encoder.width, encoder.height);
        if ('bitmap' in m) readMs += performance.now() - read;
        if (rgba && encoder.add(rgba, m.t) === 'full' && !full) { full = true; post({ type: 'full', t: m.t }); }
      }
      encodeMs += performance.now() - started;
      if (!full && m.t - judged >= 1000) {
        judged = m.t;
        const next = adaptRate(encoder.size, encoder.firstBytes, m.t, total, rate, encoder.limit);
        if (next.fps !== rate.fps || next.tolerance !== rate.tolerance) {
          // A frame that comes a little early still counts: the page's clock and the display's do not tick together.
          rate = next; encoder.tolerance = rate.tolerance; encoder.minInterval = rate.fps < 30 ? 1000 / rate.fps * 0.75 : 0;
          post({ type: 'fps', fps: rate.fps, tolerance: rate.tolerance, t: m.t });
        }
      }
      post({ type: 'progress', frames: encoder.frames, bytes: encoder.size, t: m.t, encodeMs });
      return;
    }
    if (m.type === 'stop') {
      const started = performance.now(), bytes = encoder.finish(m.t), finishMs = performance.now() - started;
      const gif = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
      post({ type: 'done', gif, frames: encoder.frames, bytes: bytes.byteLength, firstBytes: encoder.firstBytes, duration: encoder.duration, encodeMs, readMs, finishMs, full, fps: rate.fps, tolerance: rate.tolerance, refits: encoder.refits }, [gif]);
      encoder = null; reader = null;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    encoder = null;
  }
}
scope.onmessage = handle;
