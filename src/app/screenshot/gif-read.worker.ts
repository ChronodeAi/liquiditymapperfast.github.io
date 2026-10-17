import type { ToGifWorker } from './gif-protocol.ts';

/**
 * Reading a GIF's frames back to pixels, on a thread of its own: a frame comes from the page as a picture on the graphics card, and
 * reading it back mostly waits for the card. Here that wait runs beside the encoder (`gif.worker.ts`), which gets the pixels through
 * the port it shares with this worker, in the order the frames came, the end of the recording after the last of them.
 */

const scope = self as unknown as { onmessage: ((event: MessageEvent<ToGifWorker>) => void) | null };
let port: MessagePort | null = null;
let reader: OffscreenCanvasRenderingContext2D | null = null;
let width = 0, height = 0;

scope.onmessage = (event: MessageEvent<ToGifWorker>): void => {
  const m = event.data;
  if (m.type === 'port') { port = m.port; return; }
  if (!port) { if (m.type === 'frame' && 'bitmap' in m) m.bitmap.close(); return; }
  if (m.type === 'start') { width = m.width; height = m.height; reader = null; port.postMessage(m); return; }
  if (m.type === 'frame' && 'bitmap' in m) {
    const started = performance.now(), bitmap = m.bitmap;
    try {
      if (!reader) { reader = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }); if (reader) reader.globalCompositeOperation = 'copy'; }
      // Without a canvas here the frame still goes on, empty, so the page's count of frames under way stays right.
      if (!reader) { port.postMessage({ type: 'frame', t: m.t, rgba: new ArrayBuffer(0) } satisfies ToGifWorker); return; }
      reader.drawImage(bitmap, 0, 0);
      const data = reader.getImageData(0, 0, width, height).data;
      const message: ToGifWorker = { type: 'frame', t: m.t, rgba: data.buffer as ArrayBuffer, readMs: performance.now() - started };
      port.postMessage(message, [data.buffer as ArrayBuffer]);
    } finally { bitmap.close(); }
    return;
  }
  port.postMessage(m);
};
