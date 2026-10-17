import { Colors } from './gif-quant.ts';
import { FrameCoder } from './gif-encoder.ts';
import type { CodeJob, PoolToCoordinator, ToPoolWorker } from './gif-protocol.ts';

/**
 * One worker of the GIF pool. It does two things for the coordinator, one frame at a time and each frame on its own: it reads a picture
 * the page handed over back to pixels (mostly waiting for the graphics card, so a pool reads several at once), and it puts a frame's
 * pixels on the palette the coordinator chose, spreading the error where asked, and packs them (`FrameCoder`). Neither needs any other
 * frame, so frames are coded in parallel and finish in any order; the coordinator writes them in order.
 */

const scope = self as unknown as { onmessage: ((event: MessageEvent<ToPoolWorker>) => void) | null };
let port: MessagePort | null = null;
let reader: OffscreenCanvasRenderingContext2D | null = null;
let width = 0, height = 0;
const coder = new FrameCoder();

const send = (message: PoolToCoordinator, transfer: Transferable[]): void => port!.postMessage(message, transfer);

function code(job: CodeJob): void {
  const began = performance.now();
  const px = new Uint32Array(job.rgba);
  const frame = coder.encode(px, job.width, job.moved, new Colors(job.palette), job.settings);
  send({ type: 'body', seq: job.seq, body: frame.body, transparent: frame.transparent, codeMs: performance.now() - began }, [frame.body.buffer as ArrayBuffer]);
}

scope.onmessage = (event: MessageEvent<ToPoolWorker>): void => {
  const m = event.data;
  if (m.type === 'port') { port = m.port; port.onmessage = (e: MessageEvent<CodeJob>): void => code(e.data); return; }
  if (m.type === 'size') { width = m.width; height = m.height; reader = null; return; }
  const began = performance.now(), bitmap = m.bitmap;
  try {
    if (!reader) { reader = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }); if (reader) reader.globalCompositeOperation = 'copy'; }
    // Without a canvas here the frame still goes on, empty, so the coordinator's count of frames stays right.
    if (!reader) { send({ type: 'pixels', seq: m.seq, t: m.t, rgba: new ArrayBuffer(width * height * 4), readMs: 0 }, []); return; }
    reader.drawImage(bitmap, 0, 0);
    const data = reader.getImageData(0, 0, width, height).data;
    send({ type: 'pixels', seq: m.seq, t: m.t, rgba: data.buffer as ArrayBuffer, readMs: performance.now() - began }, [data.buffer as ArrayBuffer]);
  } finally { bitmap.close(); }
};
