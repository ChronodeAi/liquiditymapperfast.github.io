import type { FrameSettings } from './gif-encoder.ts';

/**
 * How a moving picture is made to fit the 15 MB a GIF may be for posting (Karl, 2026-10-17), and to use them: the best picture the
 * budget allows, not a cautious one.
 *
 * - `planGif` runs before recording, from the area and the length. What cannot change once the GIF has begun is its size, so that is chosen
 *   here (full device resolution up to twice the page's and 1920 px, smaller only when a storm of waves would not fit the length even on
 *   the cheapest rung that keeps 30 frames a second), together with the rung to begin at.
 * - `RungController` runs while recording, frame after frame, from the bytes really written. The rungs (`RUNGS`) are the pictures a frame
 *   can be, from the best to the cheapest, each a frame rate and the settings of `gif-encoder.ts`; the controller keeps the file on course
 *   for 90 % of the limit by moving down to the rung the bytes left can pay for when the frames cost more than they allow, and back up
 *   when they cost less, so a short recording is at its best throughout and a long, busy one gives up quality a few rungs at a time
 *   rather than stopping.
 * - The writer never lets the file pass `GIF_LIMIT`: it ends the GIF at the last frame that fits, which the controller works to make rare.
 *
 * Pure, and tested.
 */

/** The largest GIF that can be posted: 15 MB, and since whether a megabyte is 10^6 or 2^20 bytes there is not said, the smaller. */
export const GIF_LIMIT = 15_000_000;
/** The lengths the slider offers (seconds), and where it starts. */
export const GIF_SECONDS = { min: 1, max: 15, start: 5 } as const;

/** One picture a frame can be: the frame rate to capture at and how the frame is made. */
export interface Rung extends FrameSettings { fps: number }

/**
 * The rungs, from the best to the cheapest. Measured on recordings of the map under heavy waves, of the book and of the phone tape
 * (`Research_Results/notes/gif-capture-2026-10-17.md`), at equal bytes: letting small changes go (the tolerance) costs less picture
 * than fewer frames a second, so it rises first, from 2 levels (below that a pixel that barely moves is drawn again with a new pattern
 * of diffusion each frame, and the picture shimmers) to 24, where only the strongest of the waves still show; the frame rate comes down
 * only after that. Diffusion stays on throughout, its strength following how far the palette is from the frame (`ditherAt`).
 */
export const RUNGS: readonly Rung[] = [
  { fps: 30, tolerance: 2 }, { fps: 30, tolerance: 3 }, { fps: 30, tolerance: 4 }, { fps: 30, tolerance: 5 }, { fps: 30, tolerance: 6 }, { fps: 30, tolerance: 8 },
  { fps: 30, tolerance: 10 }, { fps: 30, tolerance: 12 }, { fps: 30, tolerance: 14 }, { fps: 30, tolerance: 16 }, { fps: 30, tolerance: 20 }, { fps: 30, tolerance: 24 },
  { fps: 20, tolerance: 24 }, { fps: 15, tolerance: 24 }, { fps: 12, tolerance: 24 }, { fps: 10, tolerance: 24 },
].map(r => ({ ...r, colors: 256, dither: 1, ditherAt: 0.3, iterations: 2, weightExp: 1 }));
export const LAST_RUNG = RUNGS.length - 1;
/** The cheapest rung that still runs at the full frame rate: the one a plan makes room for a storm on (the rungs below it give up smoothness). */
export const PLAN_FLOOR = RUNGS.findIndex(r => r.fps < RUNGS[0]!.fps) - 1;
export const rungAt = (rung: number): Rung => RUNGS[Math.max(0, Math.min(LAST_RUNG, Math.round(rung)))]!;

/**
 * What a frame costs, as bytes a pixel of the area, by rung, for frames of the busiest recordings measured (the map under constant heavy
 * waves: nearly every pixel of it moves every frame). A calmer recording costs a fraction of it, which the controller finds out in the
 * first frames and spends on quality. `FIRST_FRAME_BPP` is the first frame, written whole.
 */
export const FIRST_FRAME_BPP = 0.62;
export const STORM_BPP: readonly number[] = [0.556, 0.52, 0.485, 0.46, 0.432, 0.337, 0.28, 0.2245, 0.175, 0.1255, 0.073, 0.044, 0.05, 0.054, 0.056, 0.057];
/** How much of a storm's cost a typical recording is, and how much a plan allows for before it gives up size. */
export const TYPICAL = 0.3, STORM = 0.8;
/** The shares of the limit a plan and the controller aim for. */
export const PLAN_SHARE = 0.85, AIM_SHARE = 0.9;

export interface GifPlan {
  /** GIF pixels per CSS pixel. */
  scale: number;
  width: number; height: number;
  /** The rung to begin at, and its frame rate. */
  rung: number;
  fps: number;
  /** The estimated size (bytes) at a typical recording's cost, and whether even the cheapest rung would not fit at a storm's. */
  estimate: number;
  tight: boolean;
}

/** The estimated size of `seconds` of an area of `px` pixels at `rung`, for a recording that costs `share` of a storm's. */
export function estimateBytes(px: number, seconds: number, rung: number, share: number): number {
  const frames = Math.max(1, Math.round(seconds * rungAt(rung).fps));
  return Math.round(2000 + px * FIRST_FRAME_BPP + (frames - 1) * px * STORM_BPP[Math.max(0, Math.min(LAST_RUNG, Math.round(rung)))]! * share);
}

/**
 * The plan for an area of `w` × `h` CSS px recorded for `seconds` on a screen of `dpr` device pixels per CSS pixel. The size is the
 * largest (at most twice the page's, 1920 px on the long side) at which even a storm would fit on the cheapest rung that still runs at
 * the full frame rate (`PLAN_FLOOR`: so that a long recording of a big area is made smaller to begin with, rather than slowed or ended
 * early); the rung to begin at is the best that fits a typical recording.
 */
export function planGif(w: number, h: number, seconds: number, dpr = 1, limit = GIF_LIMIT): GifPlan {
  const long = Math.max(1, w, h), cap = Math.min(Math.max(1, Math.min(dpr, 2)), 1920 / long);
  let scale = cap, fitted = false;
  for (let i = 0; i < 40; i++) {
    const px = Math.max(1, Math.round(w * scale)) * Math.max(1, Math.round(h * scale));
    if (estimateBytes(px, seconds, PLAN_FLOOR, STORM) <= limit * 0.97) { fitted = true; break; }
    scale *= 0.94;
    if (scale < 0.2) break;
  }
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale)), px = width * height;
  let rung = LAST_RUNG;
  for (let r = 0; r <= LAST_RUNG; r++) if (estimateBytes(px, seconds, r, TYPICAL) <= limit * PLAN_SHARE) { rung = r; break; }
  return { scale, width, height, rung, fps: rungAt(rung).fps, estimate: estimateBytes(px, seconds, rung, TYPICAL), tight: !fitted };
}

/** What the controller judges a recording by. */
export interface RungOptions {
  limit: number;
  /** The length of the recording (ms). */
  total: number;
  /** The rung to begin at. */
  rung: number;
  /** The share of the limit to aim the file at. */
  share?: number;
}

/** Frames at a rung before the controller trusts them, the time (ms) a rung must have held before going back up and its longest, and how fast the average of a rung moves. */
const SETTLE = 4, HOLD_UP_MS = 300, HOLD_UP_MAX_MS = 7000, EMA = 0.2;
/** How many times over the allowance a single frame's cost must be for the controller to act on it at once. */
const EMERGENCY = 2;

/** What a frame at `to` costs against one at `from`, by the measured table. */
const ratio = (from: number, to: number): number => STORM_BPP[Math.max(0, Math.min(LAST_RUNG, to))]! / STORM_BPP[Math.max(0, Math.min(LAST_RUNG, from))]!;

/**
 * Chooses each frame's rung from the bytes the frames have cost. `decide` is called as each frame is taken (in order) and `committed` as
 * each is written (in order, written or left out as unchanged, 0 bytes), which can be some frames later when a pool codes them side by
 * side; the controller therefore judges a rung only from frames made at it, counts the frames still on their way at what they were
 * expected to cost, and does not judge again until frames made after a change have come back. It goes down at once to the rung the bytes
 * left need (from the very first frame at a rung when that one is far over, and never to a lower frame rate on a few frames' evidence)
 * and up by as many as three rungs once the rung has held for a third of a second (at the start a calm recording is back at its best in a second or so), a wait that grows after a rise that had to be undone, so a burst
 * of activity takes quality away for as long as it lasts and no longer, and a steady one does not make it hunt.
 */
export class RungController {
  rung: number;
  readonly limit: number; readonly total: number; readonly share: number;
  #decided: { rung: number; expected: number }[] = []; #head = 0;
  #bytes = 0; #elapsed = 0; #flight = 0;
  /** The average bytes of a frame made at the current rung, how many have been written, and the average of the rung before. */
  #average = 0; #held = 0; #since = 0; #holdUp = HOLD_UP_MS; #roseAt = -1e9; #before: { rung: number; average: number } | null = null;
  #taken = 0; #committed = 0; #first = true;
  constructor(options: RungOptions) { this.limit = options.limit; this.total = options.total; this.rung = Math.max(0, Math.min(LAST_RUNG, options.rung)); this.share = options.share ?? AIM_SHARE; }

  get fps(): number { return rungAt(this.rung).fps; }
  get settings(): Rung { return rungAt(this.rung); }
  /** The average bytes of a frame at this rung lately (0 before any). */
  get recent(): number { return this.#average; }
  /** Frames taken and not yet written. */
  get pending(): number { return this.#taken - this.#committed; }
  /** What the frames on their way are expected to come to (bytes). */
  get inFlight(): number { return this.#flight; }

  /** What a frame at the current rung is expected to cost: the average so far, or the rung before's scaled by the table. */
  #expected(): number {
    if (this.#held > 0) return this.#average;
    return this.#before ? this.#before.average * ratio(this.#before.rung, this.rung) : 0;
  }

  /** A frame at `elapsed` ms is taken: the rung it is made at. */
  decide(elapsed: number): number {
    this.#elapsed = elapsed; this.#taken++;
    const expected = this.#expected();
    this.#decided.push({ rung: this.rung, expected }); this.#flight += expected;
    return this.rung;
  }

  /** The next frame in order was written (`bytes` of it; 0 for one left out) and the file is `fileSize` bytes now. */
  committed(bytes: number, fileSize: number): void {
    const made = this.#decided[this.#head++]!;
    if (this.#head > 256) { this.#decided = this.#decided.slice(this.#head); this.#head = 0; }
    this.#committed++; this.#bytes = fileSize; this.#flight = Math.max(0, this.#flight - made.expected);
    // The first frame is the whole picture, which no other frame costs anything like: it counts in the file's size and in nothing else.
    if (this.#first) { this.#first = false; return; }
    if (made.rung !== this.rung) return;
    this.#average = this.#held === 0 ? bytes : this.#average + EMA * (bytes - this.#average);
    this.#held++;
    this.#judge();
  }

  /**
   * Down a rung as soon as a few frames show the cost is more than the bytes left allow, or from the first frame when it is far more
   * (each frame waited for is a frame at that cost); up only after the rung has held.
   */
  #judge(): void {
    const o: RungObservation = {
      limit: this.limit, share: this.share, bytes: this.#bytes, pending: this.#flight,
      elapsed: this.#elapsed, total: this.total, recent: this.#average,
    };
    // On the first frames at a rung nothing slower than the full frame rate is chosen: frames fewer a second are the last resort, not a
    // reaction to one expensive frame.
    const settled = this.#held >= SETTLE, mayRise = settled && this.#elapsed - this.#since >= this.#holdUp;
    const next = nextRung(this.rung, o, mayRise, settled ? LAST_RUNG : Math.max(this.rung, PLAN_FLOOR));
    if (next === this.rung || (next > this.rung && !settled && overspend(this.rung, o) < EMERGENCY)) return;
    // Going back down soon after going up means the rise was too early: the next one waits at least three times as long as the first does, then twice
    // as long again each time (at most seven seconds), and the wait is forgotten once the rung has held for a few seconds.
    if (next > this.rung && this.#elapsed - this.#roseAt < 1500) this.#holdUp = Math.min(HOLD_UP_MAX_MS, Math.max(HOLD_UP_MS * 3, this.#holdUp * 2));
    else if (this.#elapsed - this.#since > 4000) this.#holdUp = HOLD_UP_MS;
    if (next < this.rung) this.#roseAt = this.#elapsed;
    this.#before = { rung: this.rung, average: this.#average }; this.rung = next; this.#held = 0; this.#average = 0; this.#since = this.#elapsed;
  }
}

/** What `nextRung` judges: the file so far and what is on its way, how far along the recording is, and what frames at this rung cost. */
export interface RungObservation {
  limit: number; share: number;
  /** The file's size now, and the bytes of frames taken but not written (estimated). */
  bytes: number; pending: number;
  elapsed: number; total: number;
  /** Mean bytes of a frame at the current rung. */
  recent: number;
}

/** How many times what frames at `rung` cost is the allowance the bytes left give each frame (above 1: over). */
export function overspend(rung: number, o: RungObservation): number {
  const budget = o.limit * o.share - o.bytes - o.pending, seconds = Math.max(0, o.total - o.elapsed) / 1000;
  return budget <= 0 ? Infinity : o.recent / (budget / Math.max(1, seconds * rungAt(rung).fps));
}

/**
 * The rung to go on at, given what frames at `rung` cost. Down, at once, to the first rung at which the bytes left can pay for the
 * frames left (the cost of a frame at another rung taken from the table, and the frames left counted at that rung's frame rate); up one
 * rungs (at most three), once the rung has held long enough (`mayRise`), to the best one that would still fit with a fifth to spare. The cheapest
 * rung when nothing is left. `lowest` is the cheapest rung to go down to.
 */
export function nextRung(rung: number, o: RungObservation, mayRise = true, lowest = LAST_RUNG): number {
  const budget = o.limit * o.share - o.bytes - o.pending;
  if (budget <= 0) return LAST_RUNG;
  if (o.recent <= 0) return rung;
  const seconds = Math.max(0, o.total - o.elapsed) / 1000;
  /** Whether a frame at `k` would fit, given what frames at `rung` cost, with `slack` of room. */
  const fits = (k: number, slack: number): boolean => o.recent * ratio(rung, k) <= slack * budget / Math.max(1, seconds * rungAt(k).fps);
  if (!fits(rung, 1.05)) { for (let k = rung + 1; k <= Math.min(LAST_RUNG, lowest); k++) if (fits(k, 0.97)) return k; return Math.min(LAST_RUNG, lowest); }
  // Room to spare: back up to the best rung of the three above that would still fit with a fifth to spare.
  if (rung > 0 && mayRise) for (let k = Math.max(0, rung - 3); k < rung; k++) if (fits(k, 0.8)) return k;
  return rung;
}
