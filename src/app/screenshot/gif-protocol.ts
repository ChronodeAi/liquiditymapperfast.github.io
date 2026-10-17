import type { FrameSettings, Moved } from './gif-encoder.ts';

/**
 * Three kinds of thread make a GIF: the page, which composes a frame and hands it over as a picture on the graphics card; a pool of
 * workers, each of which reads a picture back to pixels and, later, puts a frame's pixels on its palette and packs them; and one
 * coordinator, which holds what the viewer sees, chooses each frame's palette and settings, writes the file in order and keeps to the
 * budget. The coordinator and each pool worker talk through a port of their own.
 */

/** The page to the coordinator. */
export type ToCoordinator =
  | { type: 'start'; width: number; height: number; limit: number; total: number; rung: number; ports: MessagePort[] }
  /** A frame the page read back itself (where it cannot hand pictures over). */
  | { type: 'pixels'; seq: number; t: number; rgba: ArrayBuffer }
  /** The recording ended at `t` ms; `count` frames (numbered from 0) were sent. */
  | { type: 'stop'; t: number; count: number }
  | { type: 'cancel' };

/** The page to a pool worker. */
export type ToPoolWorker =
  | { type: 'port'; port: MessagePort }
  | { type: 'size'; width: number; height: number }
  /** A frame as a picture: read back to pixels and handed to the coordinator. */
  | { type: 'frame'; seq: number; t: number; bitmap: ImageBitmap };

/** A pool worker to the coordinator. */
export type PoolToCoordinator =
  | { type: 'pixels'; seq: number; t: number; rgba: ArrayBuffer; readMs: number }
  /** A frame coded: its bytes from the image descriptor on. */
  | { type: 'body'; seq: number; body: Uint8Array; transparent: number; codeMs: number };

/** The coordinator to a pool worker. */
export interface CodeJob {
  type: 'code'; seq: number; width: number;
  /** The frame's pixels, those it leaves alone zeroed. */
  rgba: ArrayBuffer;
  moved: Moved; palette: Uint8Array; settings: FrameSettings;
}

/**
 * The coordinator to the page: how far a frame has got (after each one drained, written or left out as unchanged), the frame rate to go on
 * at, `full` when the file reached its limit (it ends there), and the finished file.
 */
export type FromCoordinator =
  | { type: 'progress'; seq: number; frames: number; bytes: number; rung: number; fps: number }
  | { type: 'rate'; fps: number; rung: number }
  | { type: 'full'; t: number }
  | { type: 'done'; gif: ArrayBuffer; stats: GifStats }
  | { type: 'error'; message: string };

/** What a recording came to, for the page and the notes: sizes, the quality it ended at, and where the time went. */
export interface GifStats {
  frames: number; written: number; bytes: number; firstBytes: number; duration: number; full: boolean;
  fps: number; rung: number; meanRung: number; minRung: number; maxRung: number; tolerance: number;
  /** Mean time (ms) per frame in the coordinator's stages and in the pool's. */
  diffMs: number; paletteMs: number; readMs: number; codeMs: number;
  /** Time from the stop to the finished file (ms). */
  finishMs: number;
  refits: number; seededShare: number;
}
