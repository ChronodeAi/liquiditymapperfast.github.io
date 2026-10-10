/**
 * Slicers: an automated program working a large order as a steady stream of small market orders ("clips"), for minutes to hours. On a chart
 * it is a CVD line that runs straight; here it is told by its clips.
 *
 * Every market order from `minClipUsd` goes into a logarithmic size bucket, and a bucket with its two neighbours makes a size family (the
 * clip size is found, never set). Each minute, over the ten minutes up to its end, a family is a candidate when it jointly has
 *  - enough clips and dollars a minute on its side (`minRate`, `minUsdPerMin`), most of its clips on that side (`minDirection`),
 *  - a cadence: the gaps between the seconds holding its clips have one most common length, at most `maxGap` seconds, that takes at least
 *    `minGapShare` of them, and its last clip at most `maxStaleS` before the minute's end,
 *  - for the exact kind, sizes within `maxSpread` of their median (a fixed clip). The wide kind (buckets 50 % apart, so a
 *    family spans about 3.4 times in size; no size test; more clips a minute) finds programs that draw each clip's size at random, as the
 *    ETH spot buyer of 2026-10-10 did ($1-6K about once a second), which no fixed-size test sees. Narrower wide families split such a range
 *    between minutes and lose its cadence (25 %: its gap share hovered at 46-59 %, a candidate in a third of its minutes).
 * A family that is a candidate `sustain` minutes in a row is an episode: the first of those minutes is its onset, the last its alert. It
 * goes on while a family of its side overlapping its sizes stays a candidate with `keepDirection` of its clips on that side, and ends
 * after `inactivity` minutes without one. The same side and clip again within `suppressMin` is a repeat: kept, not announced.
 *
 * The clips are the market orders rebuilt from fills (orders.ts): a child order that took two price levels is one clip, where Binance's
 * aggregate trades split it. Each second keeps at most `perSecond` orders a side, the largest. A minute is judged on the exchange's times
 * once `step` is given a clock `GRACE_MS` past its end; an order arriving later still counts in the windows after it. Measured on Binance
 * 2026-10-06..10 (Research_Findings.md). What this says is what traded: a program can be half of a hedge (a BTC spot seller and a
 * perpetual buyer ran $4.14K clips in the same seconds on 2026-10-10), and nothing here knows who or why.
 */

export interface SlicerKind {
  name: 'exact' | 'wide';
  /** Width of a size bucket as a fraction (0.002: buckets 0.2 % apart). */
  bucket: number;
  minRate: number; maxGap: number; maxSpread: number; minDirection: number;
}
export interface SlicerOptions {
  windowMin: number; minClipUsd: number; minUsdPerMin: number; minGapShare: number; minGaps: number; maxStaleS: number;
  sustain: number; inactivity: number; suppressMin: number; perSecond: number;
  /** How far apart (as a fraction) two families' sizes may be and still be one program from minute to minute. */
  match: number;
  /** The share of its family's clips a running episode's side must keep (one still building needs its kind's `minDirection`). */
  keepDirection: number;
  kinds: readonly SlicerKind[];
}
/** The exact kind's settings, and the wide kind measured beside them. */
export const SLICER_DEFAULTS: SlicerOptions = {
  windowMin: 10, minClipUsd: 1000, minUsdPerMin: 50_000, minGapShare: 0.5, minGaps: 20, maxStaleS: 90,
  sustain: 15, inactivity: 5, suppressMin: 360, perSecond: 5, match: 0.025, keepDirection: 0.75,
  kinds: [
    { name: 'exact', bucket: 0.002, minRate: 5, maxGap: 30, maxSpread: 0.002, minDirection: 0.9 },
    { name: 'wide', bucket: 0.5, minRate: 20, maxGap: 5, maxSpread: Infinity, minDirection: 0.9 },
  ],
};
/** A minute is judged once the clock is this far past its end, so the orders still being rebuilt or delivered are in. */
export const GRACE_MS = 2_000;
const MINUTE = 60_000, SECOND = 1_000;

export type Side = 'buy' | 'sell';
export interface SlicerEpisode {
  /** `instrument|side|onset`: one episode keeps it from its alert to its end. */
  id: string; instrumentId: string; side: Side;
  /** Starts of the first candidate minute, of the minute it alerted, of the last candidate minute; the end once it is over. */
  onset: number; alertAt: number; last: number; end: number | null;
  /** The clips' sizes (smallest, largest, median) in the last window, and the window's clips and dollars a minute on its side. */
  lo: number; hi: number; clip: number; rate: number; usdPerMin: number;
  /** The most common gap in seconds and its share of the gaps, and the share of the family's clips on its side. */
  gap: number; gapShare: number; direction: number;
  /** Dollars of its clips since the onset on its side and against it (the candidate minutes only, so at least this much). */
  total: number; against: number;
  /** It passed the fixed-size test at least once (else only the wide one). */
  exact: boolean;
  /** A family of the same sizes alerted within `suppressMin`: shown, not announced. */
  repeat: boolean;
}

/** One family's reading of a window. */
export interface FamilyReading {
  kind: SlicerKind['name']; side: Side; lo: number; hi: number; clip: number; spread: number;
  rate: number; usdPerMin: number; direction: number; gap: number; gapShare: number; gaps: number; staleS: number;
  /** Dollars of its clips inside the judged minute, on its side and against it. */
  minuteUsd: number; minuteAgainst: number;
  candidate: boolean;
}
interface Clip { s: number; side: Side; usd: number }

const median = (sorted: readonly number[]): number => { const n = sorted.length; return n % 2 ? sorted[n >> 1]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2; };

/** Size families of a window's clips: buckets by count, the fullest first, each taking its free neighbours. */
export function families(clips: readonly Clip[], bucket: number): Clip[][] {
  const width = Math.log1p(bucket), by = new Map<number, Clip[]>();
  for (const c of clips) { const b = Math.round(Math.log(c.usd) / width); const list = by.get(b); if (list) list.push(c); else by.set(b, [c]); }
  const used = new Set<number>(), out: Clip[][] = [];
  for (const seed of [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length || a - b)) {
    if (used.has(seed)) continue;
    const group: Clip[] = [];
    for (const k of [seed - 1, seed, seed + 1]) { const list = by.get(k); if (list && !used.has(k)) { used.add(k); group.push(...list); } }
    out.push(group);
  }
  return out;
}

/** One family read over the window ending at `end` (the judged minute's last second), for the minute starting at `minute`. */
export function readFamily(group: readonly Clip[], kind: SlicerKind, o: SlicerOptions, minute: number, end: number): FamilyReading {
  let buys = 0; for (const c of group) if (c.side === 'buy') buys++;
  const side: Side = buys >= group.length - buys ? 'buy' : 'sell', own = group.filter(c => c.side === side);
  const seconds = [...new Set(own.map(c => c.s))].sort((a, b) => a - b), counts = new Map<number, number>();
  for (let i = 1; i < seconds.length; i++) { const g = (seconds[i]! - seconds[i - 1]!) / SECOND; counts.set(g, (counts.get(g) ?? 0) + 1); }
  let gap = 0, gapN = 0; for (const [g, n] of counts) if (n > gapN || (n === gapN && g < gap)) { gap = g; gapN = n; }
  const gaps = Math.max(0, seconds.length - 1), sizes = group.map(c => c.usd).sort((a, b) => a - b), clip = median(sizes);
  const spread = median(sizes.map(u => Math.abs(u - clip)).sort((a, b) => a - b)) / clip;
  let ownUsd = 0, minuteUsd = 0, minuteAgainst = 0;
  for (const c of group) { if (c.side === side) ownUsd += c.usd; if (c.s >= minute) { if (c.side === side) minuteUsd += c.usd; else minuteAgainst += c.usd; } }
  const rate = own.length / o.windowMin, usdPerMin = ownUsd / o.windowMin, direction = own.length / group.length;
  const staleS = (end - seconds[seconds.length - 1]!) / SECOND, gapShare = gaps ? gapN / gaps : 0;
  const candidate = rate >= kind.minRate && usdPerMin >= o.minUsdPerMin && gaps >= o.minGaps && gap > 0 && gap <= kind.maxGap
    && gapShare >= o.minGapShare && spread <= kind.maxSpread && staleS <= o.maxStaleS;
  return { kind: kind.name, side, lo: sizes[0]!, hi: sizes[sizes.length - 1]!, clip, spread, rate, usdPerMin, direction, gap, gapShare, gaps, staleS, minuteUsd, minuteAgainst, candidate };
}

interface Track {
  side: Side; lo: number; hi: number; clip: number; onset: number; minutes: number; active: boolean; inactive: number;
  total: number; against: number; exact: boolean; episode: SlicerEpisode | null;
}
interface Instrument {
  /** Second start → the largest clips of that second, per side. */
  seconds: Map<number, { buy: number[]; sell: number[] }>;
  /** The start of the next minute to judge. */
  next: number;
  tracks: Track[];
  /** Alerts within the suppression time: their side, sizes and minute. */
  recent: { side: Side; lo: number; hi: number; clip: number; exact: boolean; at: number }[];
}

const keepLargest = (list: number[], usd: number, n: number): void => {
  if (list.length < n) { list.push(usd); return; }
  let min = 0; for (let i = 1; i < list.length; i++) if (list[i]! < list[min]!) min = i;
  if (usd > list[min]!) list[min] = usd;
};

/** Finds slicers in the market orders of each instrument (see the module comment). */
export class SlicerDetector {
  readonly options: SlicerOptions;
  readonly #instruments = new Map<string, Instrument>();
  #fresh: SlicerEpisode[] = [];

  /** `scale` is the coin's size multiplier (coins.ts `scaleOf`): the clip and dollar floors follow it. */
  constructor(options: Partial<SlicerOptions> = {}, scale = 1) {
    const o = { ...SLICER_DEFAULTS, ...options };
    this.options = { ...o, minClipUsd: o.minClipUsd * scale, minUsdPerMin: o.minUsdPerMin * scale };
  }

  /** Market orders, complete (`OrderBuilder.drain`). An instrument is watched from the first whole minute after its first order of any size. */
  add(orders: Iterable<{ instrumentId: string; side: Side; t: number; usd: number }>): void {
    const o = this.options, window = o.windowMin * MINUTE;
    for (const order of orders) {
      if (!Number.isFinite(order.t) || !(order.usd > 0)) continue;
      let inst = this.#instruments.get(order.instrumentId);
      if (!inst) {
        // The first window to judge must lie wholly after the first order: before it, nothing says the feed was there.
        const watched = Math.floor(order.t / MINUTE) * MINUTE + MINUTE;
        inst = { seconds: new Map(), next: watched + window - MINUTE, tracks: [], recent: [] };
        this.#instruments.set(order.instrumentId, inst);
      }
      if (order.usd < o.minClipUsd) continue;
      const s = Math.floor(order.t / SECOND) * SECOND;
      if (s < inst.next + MINUTE - window) continue;
      let sec = inst.seconds.get(s); if (!sec) { sec = { buy: [], sell: [] }; inst.seconds.set(s, sec); }
      keepLargest(sec[order.side], order.usd, o.perSecond);
    }
  }

  /** Judge every minute whose end is `GRACE_MS` behind `now` (the clock the orders' times are on). */
  step(now: number): void {
    const window = this.options.windowMin * MINUTE;
    for (const [id, inst] of this.#instruments) {
      while (inst.next + MINUTE + GRACE_MS <= now) { this.#judge(id, inst, inst.next); inst.next += MINUTE; }
      const from = inst.next + MINUTE - window;
      for (const s of inst.seconds.keys()) if (s < from) inst.seconds.delete(s);
    }
  }

  /** Episodes that alerted, changed or ended since the last call (a snapshot of each). */
  takeFresh(): SlicerEpisode[] { const out = this.#fresh; this.#fresh = []; return out; }
  /** The episodes running now. */
  active(): SlicerEpisode[] { return [...this.#instruments.values()].flatMap(i => i.tracks.filter(t => t.episode).map(t => ({ ...t.episode! }))); }

  /** The readings of one minute's window for an instrument (for tests and the replay's diagnostics). */
  read(id: string, minute: number): FamilyReading[] {
    const inst = this.#instruments.get(id);
    return inst ? this.#readings(inst, minute) : [];
  }

  #readings(inst: Instrument, minute: number): FamilyReading[] {
    const o = this.options, end = minute + MINUTE - SECOND, from = end - o.windowMin * MINUTE + SECOND, clips: Clip[] = [];
    for (const [s, sec] of inst.seconds) if (s >= from && s <= end) { for (const usd of sec.buy) clips.push({ s, side: 'buy', usd }); for (const usd of sec.sell) clips.push({ s, side: 'sell', usd }); }
    if (!clips.length) return [];
    return o.kinds.flatMap(kind => families(clips, kind.bucket).map(g => readFamily(g, kind, o, minute, end)));
  }

  #judge(id: string, inst: Instrument, minute: number): void {
    const o = this.options;
    const kinds = new Map(o.kinds.map(k => [k.name, k]));
    const candidates = this.#readings(inst, minute).filter(r => r.candidate).sort((a, b) => b.usdPerMin - a.usdPerMin);
    const near = (a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean => a.lo <= b.hi * (1 + o.match) && b.lo <= a.hi * (1 + o.match);
    const hits = new Map<Track, FamilyReading[]>();
    for (const r of candidates) {
      const directed = r.direction >= kinds.get(r.kind)!.minDirection;
      // One still building needs every minute directed; a running episode goes on with `keepDirection` (keeping it on any direction,
      // which in a busy market let a wide family of unrelated orders hold an episode open long after its program stopped).
      let track = inst.tracks.find(t => t.side === r.side && near(t, r) && (t.active ? r.direction >= o.keepDirection : directed));
      if (!track) {
        if (!directed) continue;
        track = { side: r.side, lo: r.lo, hi: r.hi, clip: r.clip, onset: minute, minutes: 0, active: false, inactive: 0, total: 0, against: 0, exact: false, episode: null };
        inst.tracks.push(track);
      }
      const list = hits.get(track); if (list) list.push(r); else hits.set(track, [r]);
    }
    const kept: Track[] = [];
    for (const track of inst.tracks) {
      const seen = hits.get(track);
      if (!seen) {
        if (track.active && ++track.inactive < o.inactivity) { kept.push(track); continue; }
        if (track.episode) { track.episode.end = track.episode.last + MINUTE; this.#fresh.push({ ...track.episode }); }
        continue;
      }
      // One reading speaks for the minute: an exact family when there is one (the wide family around it also holds unrelated orders of
      // nearby sizes), else the strongest. A fixed-size program's numbers come from its exact family only: a minute where just the wide
      // one around it qualifies keeps it going and adds nothing.
      const exactHit = seen.find(r => r.kind === 'exact'), best = exactHit ?? seen[0]!, counts = !track.exact || exactHit !== undefined;
      track.minutes++; track.inactive = 0;
      if (counts) { track.lo = best.lo; track.hi = best.hi; track.clip = best.clip; track.total += best.minuteUsd; track.against += best.minuteAgainst; }
      if (exactHit) track.exact = true;
      if (!track.active && track.minutes >= o.sustain) {
        track.active = true;
        // A repeat is the same side and the same clip: a fixed clip within `match` of the earlier one, a random one's sizes overlapping.
        inst.recent = inst.recent.filter(r => r.at > minute - o.suppressMin * MINUTE);
        const repeat = inst.recent.some(r => r.side === track.side && (r.exact && track.exact ? Math.abs(track.clip / r.clip - 1) <= o.match : near(r, track)));
        if (!repeat) inst.recent.push({ side: track.side, lo: track.lo, hi: track.hi, clip: track.clip, exact: track.exact, at: minute });
        track.episode = {
          id: `${id}|${track.side}|${track.onset}`, instrumentId: id, side: track.side, onset: track.onset, alertAt: minute, last: minute, end: null,
          lo: 0, hi: 0, clip: 0, rate: 0, usdPerMin: 0, gap: 0, gapShare: 0, direction: 0, total: 0, against: 0, exact: false, repeat,
        };
      }
      if (track.episode) {
        track.episode.last = minute;
        if (counts) Object.assign(track.episode, { lo: track.lo, hi: track.hi, clip: best.clip, rate: best.rate, usdPerMin: best.usdPerMin, gap: best.gap,
          gapShare: best.gapShare, direction: best.direction, total: track.total, against: track.against, exact: track.exact });
        this.#fresh.push({ ...track.episode });
      }
      kept.push(track);
    }
    inst.tracks = kept;
  }
}
