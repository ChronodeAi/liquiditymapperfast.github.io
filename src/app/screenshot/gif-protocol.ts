import type { Rgb } from './gif-encoder.ts';

/**
 * What the page tells the GIF workers: the file to make, each frame as it is captured (a picture, which the reader turns into pixels for
 * the encoder, with the time that took; or the pixels themselves), and the end. `port` joins the reader to the encoder.
 */
export type ToGifWorker =
  | { type: 'port'; port: MessagePort }
  | { type: 'start'; width: number; height: number; colors: number; dither: boolean; tolerance: number; limit: number; tints: Rgb[]; dark: boolean; fps: number; total: number }
  | { type: 'frame'; t: number; bitmap: ImageBitmap }
  | { type: 'frame'; t: number; rgba: ArrayBuffer; readMs?: number }
  | { type: 'stop'; t: number };

/**
 * What the worker answers: after each frame how far it is (`bytes` the file's size if it ended there), a lower frame rate when the file
 * would grow past its limit at the rate so far, `full` when it reached the limit (the file ends there), and the finished file.
 */
export type FromGifWorker =
  | { type: 'progress'; frames: number; bytes: number; t: number; encodeMs: number }
  | { type: 'fps'; fps: number; tolerance: number; t: number }
  | { type: 'full'; t: number }
  | { type: 'done'; gif: ArrayBuffer; frames: number; bytes: number; firstBytes: number; duration: number; encodeMs: number; readMs: number; finishMs: number; full: boolean; fps: number; tolerance: number; refits: number }
  | { type: 'error'; message: string };
