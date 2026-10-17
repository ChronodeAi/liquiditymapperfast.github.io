/**
 * How a moving picture is kept under the size a GIF may be for posting (15 MB, Karl 2026-10-17). Before recording, `planGif` picks the scale, the frame rate and the
 * colours from the area and the length, on an estimate of what a frame of the chart costs; while recording, `adaptRate` first lets
 * small changes go and then lowers the frame rate when the bytes written so far say the estimate was low; and the encoder itself never
 * writes a frame that would take the file past `GIF_LIMIT` (it ends there). Pure and tested.
 */

/** The largest GIF that can be posted: 15 MB, and since whether a megabyte is 10^6 or 2^20 bytes there is not said, the smaller. */
export const GIF_LIMIT = 15_000_000;
/** The lengths the slider offers (seconds), and where it starts. */
export const GIF_SECONDS = { min: 1, max: 15, start: 5 } as const;
/** The frame rates a plan may choose, fastest first. */
export const GIF_FPS: readonly number[] = [30, 25, 20, 15, 12, 10];
/**
 * How many levels a pixel may move and still count as unchanged (`GifOptions.tolerance`): a little from the start (the waves' faint light
 * otherwise flickers through the palette over the whole chart), more once the file grows too fast.
 */
export const GIF_TOLERANCE = { start: 6, raised: 16 } as const;

/**
 * What a frame costs, measured on recordings of the map with the glass's waves running (`Research_Findings.md`): the first frame, written
 * whole, about this many bytes a pixel; every later one about this many, a share of its pixels having changed and the rest folded into
 * the "unchanged" index. Both are set above what was measured, so a plan errs toward a smaller file.
 */
export const FIRST_FRAME_BPP = 0.75;
export const LATER_FRAME_BPP = 0.16;
/** A plan aims at this share of the limit, leaving room for a busier recording than the estimate. */
export const PLAN_SHARE = 0.8;

export interface GifPlan {
  /** GIF pixels per CSS pixel. */
  scale: number;
  width: number; height: number;
  fps: number;
  colors: number;
  dither: boolean;
  tolerance: number;
  /** The estimated size (bytes). */
  estimate: number;
  /** Whether even the smallest plan's estimate is over the limit (the recording will then end early). */
  tight: boolean;
}

/** The estimated size of a recording of `width` × `height` GIF pixels for `seconds` at `fps`. */
export function estimateBytes(width: number, height: number, seconds: number, fps: number, colors = 255): number {
  const pixels = width * height, frames = Math.max(1, Math.round(seconds * fps));
  // Fewer colours take fewer bits a code.
  const bits = colors > 128 ? 1 : colors > 64 ? 0.9 : 0.8;
  return Math.round(1200 + pixels * FIRST_FRAME_BPP * bits + (frames - 1) * pixels * LATER_FRAME_BPP * bits);
}

/**
 * The plan for an area of `w` × `h` CSS px recorded for `seconds` on a screen of `dpr` device pixels per CSS pixel. The frame rate is
 * kept up first (30, then 25, then 20 at full size), then the size is let go down to three quarters, then the frame rate to 15, then the
 * size to a half, then the frame rate to 10, then the size, and last the colours. A GIF is never larger than 1920 px on its long side.
 */
export function planGif(w: number, h: number, seconds: number, dpr = 1, limit = GIF_LIMIT): GifPlan {
  const long = Math.max(1, w, h), cap = Math.min(Math.max(1, Math.min(dpr, 2)), 1920 / long);
  const steps: [number, number, number][] = [];
  if (cap > 1) steps.push([cap, 30, 255], [cap, 25, 255]);
  for (const [s, fps] of [[1, 30], [1, 25], [1, 20], [0.85, 20], [0.75, 20], [0.75, 15], [0.6, 15], [0.5, 15], [0.5, 12], [0.5, 10], [0.4, 10], [0.33, 10], [0.25, 10]] as const) steps.push([Math.min(s, cap), fps, 255]);
  steps.push([Math.min(0.25, cap), 10, 128], [Math.min(0.25, cap), 10, 64]);
  const target = limit * PLAN_SHARE;
  let chosen: GifPlan | null = null;
  for (const [scale, fps, colors] of steps) {
    const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
    const estimate = estimateBytes(width, height, seconds, fps, colors);
    chosen = { scale, width, height, fps, colors, dither: false, tolerance: GIF_TOLERANCE.start, estimate, tight: estimate > limit };
    if (estimate <= target) return chosen;
  }
  return chosen!;
}

/** How a recording goes on: its frame rate and its tolerance (`GIF_TOLERANCE`). */
export interface Rate { fps: number; tolerance: number }

/**
 * How to go on, `elapsed` ms into a recording of `total` ms that has written `bytes` so far (`first` of them the first frame and the
 * file's head): unchanged while the bytes written since the first frame, carried on at the same rate to the end, stay under `share` of
 * the limit; past it, small changes are let go first (the raised tolerance: the cheapest saving, as most of the bytes go on light that
 * barely shows), then the frame rate is halved, not below 10. It is asked about once a second, after the first second.
 */
export function adaptRate(bytes: number, first: number, elapsed: number, total: number, rate: Rate, limit = GIF_LIMIT, share = 0.92): Rate {
  const slowest = GIF_FPS[GIF_FPS.length - 1]!;
  if (elapsed < 1000 || elapsed >= total || (rate.fps <= slowest && rate.tolerance >= GIF_TOLERANCE.raised)) return rate;
  const pace = Math.max(0, bytes - first) / elapsed, projected = bytes + pace * (total - elapsed);
  if (projected <= limit * share) return rate;
  if (rate.tolerance < GIF_TOLERANCE.raised) return { fps: rate.fps, tolerance: GIF_TOLERANCE.raised };
  return { fps: Math.max(slowest, Math.floor(rate.fps / 2)), tolerance: rate.tolerance };
}
