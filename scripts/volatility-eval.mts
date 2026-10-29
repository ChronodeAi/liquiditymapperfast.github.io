/**
 * Measure the volatility log, `volatility-log.jsonl`, against what price did next (docs/volatility-watch.md).
 *
 *   npm run volatility:eval -- [--log <path>] [--horizon 15] [--k 3]
 *
 * A row is "volatile" when, within `horizon` minutes after it, price's largest excursion from the row's price is at least `k` times the
 * standard deviation of 15-minute returns over the 24 hours of rows before it. Jev's score and each concept's yes probability (rows Jev
 * answered) are ranked against that (ROC AUC, Brier), beside a plain baseline (the largest of |spotZ15|, |perpZ15|, |retZ15|, volSigma and
 * liqZ5) and the model-free confluence, recomputed from each row's logged values so rows written before it existed count too. The
 * confluence's calls are also scored as trades: the return from the row to the horizon, signed by the call's direction. The page warns only
 * while price is not already moving (`MOVE_SIGMA` in shared/volatility/features.ts), so each model is also judged as an early warning on
 * those rows alone: its score against the range price had just covered, and its warnings' precision and recall.
 */
import fs from 'node:fs';
import path from 'node:path';
import { confluence, type Confluence } from '../src/shared/volatility/confluence.ts';
import { MOVE_SIGMA } from '../src/shared/volatility/features.ts';
import { WARN_MIN_CONFIDENCE, WARN_MIN_SCORE } from '../src/shared/volatility/jev.ts';

const MINUTE = 60_000;

export interface Row {
  features: { coin: string; t: number; price: number; values: Record<string, number | boolean | null> };
  /** Absent on a minute Jev was not asked (no key, backing off) or did not answer. */
  verdict?: { score: number; scoreConfidence: number; direction: 'up' | 'down'; directionP: number; concepts: Record<string, number>; ms?: number; inputTokens?: number };
  /** The SubQ arms' verdicts on the same minute (see `SUBQ_ARMS` in shared/volatility/jev.ts). */
  arms?: Partial<Record<'subq' | 'subqHistory' | 'subqImage', Row['verdict']>>;
}
/**
 * `ret`: log return (%) from the row to the last row within the horizon; `sd`: the standard deviation of 15-minute log returns it was judged
 * by; `moved`: the range of prices over the 15 minutes up to the row, in those standard deviations, and `underway` when that is a move
 * already (`MOVE_SIGMA` or more).
 */
export interface Labelled { row: Row; volatile: boolean; up: boolean; ret: number; sd: number; moved: number; underway: boolean }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

/** The rows of a log, oldest file first; a line that does not parse is skipped. */
export function readLog(file: string): Row[] {
  const rotated = path.join(path.dirname(file), 'volatility-log.1.jsonl');
  const rows: Row[] = [];
  for (const f of [rotated, file]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Row;
        if (typeof row.features?.t === 'number' && row.features.price > 0 && typeof row.features.values === 'object' && row.features.values !== null) rows.push(row);
      } catch { /* a torn last line */ }
    }
  }
  return rows;
}

/**
 * Each row that has 48 15-minute returns in the 24 hours before it and a log reaching its horizon, judged volatile when its largest move within
 * the horizon is at least `k` standard deviations of those returns.
 */
export function label(rows: readonly Row[], horizonMin: number, k: number): Labelled[] {
  const out: Labelled[] = [];
  const byCoin = new Map<string, Row[]>();
  for (const r of rows) { const list = byCoin.get(r.features.coin) ?? []; list.push(r); byCoin.set(r.features.coin, list); }
  for (const list of byCoin.values()) {
    list.sort((a, b) => a.features.t - b.features.t);
    const priceAt = new Map(list.map(r => [r.features.t, r.features.price]));
    // 15-minute log returns ending at each row (where the row 15 minutes earlier exists), oldest first, and their running sums: the 24 hours
    // before a row are the returns between two indices that only move forward.
    const returns = list.flatMap(r => { const p0 = priceAt.get(r.features.t - 15 * MINUTE); return p0 ? [{ t: r.features.t, r: Math.log(r.features.price / p0) }] : []; });
    const sums = new Float64Array(returns.length + 1), squares = new Float64Array(returns.length + 1);
    for (let i = 0; i < returns.length; i++) { sums[i + 1] = sums[i]! + returns[i]!.r; squares[i + 1] = squares[i]! + returns[i]!.r ** 2; }
    let from = 0, to = 0;
    for (let i = 0; i < list.length; i++) {
      const row = list[i]!, t = row.features.t, p = row.features.price;
      while (to < returns.length && returns[to]!.t <= t) to++;
      while (from < to && returns[from]!.t <= t - 24 * 60 * MINUTE) from++;
      const n = to - from;
      if (n < 48) continue;
      const m = (sums[to]! - sums[from]!) / n, sd = Math.sqrt(Math.max(0, (squares[to]! - squares[from]!) / n - m * m));
      if (!(sd > 0)) continue;
      let extreme = 0, last = t, lastPrice = p;
      for (let j = i + 1; j < list.length && list[j]!.features.t <= t + horizonMin * MINUTE; j++) {
        const x = Math.log(list[j]!.features.price / p); last = list[j]!.features.t; lastPrice = list[j]!.features.price;
        if (Math.abs(x) > Math.abs(extreme)) extreme = x;
      }
      if (last < t + (horizonMin - 2) * MINUTE) continue; // the log ends before the horizon does
      let high = p, low = p;
      for (let j = i - 1; j >= 0 && list[j]!.features.t >= t - 15 * MINUTE; j--) { const x = list[j]!.features.price; if (x > high) high = x; if (x < low) low = x; }
      const moved = Math.log(high / low) / sd;
      out.push({ row, volatile: Math.abs(extreme) >= k * sd, up: extreme > 0, ret: Math.log(lastPrice / p) * 100, sd, moved, underway: moved >= MOVE_SIGMA });
    }
  }
  return out;
}

/** ROC AUC by the Mann-Whitney rank sum, ties at their average rank; null when one class is empty. */
export function auc(scores: readonly number[], positive: readonly boolean[]): number | null {
  const n = scores.length, order = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const rank = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i; while (j + 1 < n && scores[order[j + 1]!] === scores[order[i]!]) j++;
    for (let x = i; x <= j; x++) rank[order[x]!] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let pos = 0, sum = 0;
  for (let i = 0; i < n; i++) if (positive[i]) { pos++; sum += rank[i]!; }
  const neg = n - pos;
  return pos === 0 || neg === 0 ? null : (sum - pos * (pos + 1) / 2) / (pos * neg);
}

const brier = (p: readonly number[], y: readonly boolean[]): number => p.reduce((s, x, i) => s + (x - (y[i] ? 1 : 0)) ** 2, 0) / p.length;
const num = (v: number | boolean | null | undefined): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const fmt = (x: number | null, d = 3): string => x === null ? 'n/a' : x.toFixed(d);
const pctOf = (a: number, b: number): string => b ? `${(a / b * 100).toFixed(1)} %` : 'n/a';
const bp = (xs: readonly number[]): string => xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length * 100).toFixed(1)} bp` : 'n/a';

/**
 * How the confluence did: as a ranking of volatility (|score|), its direction on volatile rows, and its calls as trades held to the horizon
 * (the mean signed return, against the mean absolute return of every row as the scale of a coin flip's luck).
 */
export function confluenceReport(labelled: readonly Labelled[]): string[] {
  const read = labelled.map(l => ({ l, c: confluence(l.row.features.values) as Confluence }));
  const lines: string[] = [];
  const y = read.map(x => x.l.volatile);
  lines.push(`confluence |score| AUC: ${fmt(auc(read.map(x => Math.abs(x.c.score)), y))}`);
  const volatileDirected = read.filter(x => x.l.volatile && x.c.direction), right = volatileDirected.filter(x => (x.c.direction === 'up') === x.l.up).length;
  lines.push(`confluence direction on volatile rows: ${volatileDirected.length ? `${right}/${volatileDirected.length} = ${pctOf(right, volatileDirected.length)}` : 'n/a'}`);
  const calls = read.filter(x => x.c.call), signed = (x: { l: Labelled; c: Confluence }): number => (x.c.direction === 'up' ? 1 : -1) * x.l.ret;
  const callsVolatile = calls.filter(x => x.l.volatile).length, callsRight = calls.filter(x => signed(x) > 0).length;
  lines.push(`confluence calls: ${calls.length}, of them volatile ${pctOf(callsVolatile, calls.length)}, right way at the horizon ${pctOf(callsRight, calls.length)}, mean signed return ${bp(calls.map(signed))} (every row's mean |return| ${bp(read.map(x => Math.abs(x.l.ret)))})`);
  const directed = read.filter(x => x.c.direction && x.c.agree >= 2 && x.c.against === 0);
  lines.push(`families agreeing (any trigger or none): ${directed.length}, right way ${pctOf(directed.filter(x => signed(x) > 0).length, directed.length)}, mean signed return ${bp(directed.map(signed))}`);
  return lines;
}

function main(): void {
  const file = arg('log', 'data/runtime/volatility-log.jsonl'), horizon = Number(arg('horizon', '15')), k = Number(arg('k', '3'));
  if (!fs.existsSync(file)) { console.error(`no log at ${file}`); process.exit(1); }
  const rows = readLog(file), labelled = label(rows, horizon, k);
  console.log(`log ${file}: ${rows.length} minutes, ${labelled.length} labelled (horizon ${horizon} min, volatile = move of ${k} sigma of 15-minute returns)`);
  const y = labelled.map(l => l.volatile), positives = y.filter(Boolean).length;
  if (!labelled.length) { console.log('nothing labelled yet: needs 48 rows of history before a row and the horizon after it'); return; }
  console.log(`base rate: ${(positives / labelled.length * 100).toFixed(1)} % (${positives} volatile)`);
  const quiet = labelled.filter(l => !l.underway), quietY = quiet.map(l => l.volatile);
  console.log(`not already moving (price within ${MOVE_SIGMA} sd over the 15 minutes before): ${quiet.length} rows, ${pctOf(quietY.filter(Boolean).length, quiet.length)} volatile; the range they had covered ranks them with AUC ${fmt(auc(quiet.map(l => l.moved), quietY))}\n`);
  for (const line of confluenceReport(labelled)) console.log(line);

  for (const model of MODELS) {
    const judged = labelled.filter(l => verdictOf(l.row, model)), yj = judged.map(l => l.volatile);
    console.log(`\n== ${model}: answered ${judged.length} of the labelled minutes`);
    if (!judged.length) continue;
    const v = (l: Labelled): Verdict => verdictOf(l.row, model)!;
    const table: [string, number[], boolean][] = [
      ['score / 4', judged.map(l => v(l).score / 4), true],
      ['baseline max(|z|)', judged.map(l => { const x = l.row.features.values; return Math.max(Math.abs(num(x.spotZ15)), Math.abs(num(x.perpZ15)), Math.abs(num(x.retZ15)), num(x.volSigma), num(x.liqZ5)); }), false],
    ];
    const ids = [...new Set(judged.flatMap(l => Object.keys(v(l).concepts)))].sort();
    for (const id of ids) table.push([`concept ${id}`, judged.map(l => v(l).concepts[id] ?? 0), true]);
    const width = Math.max(...table.map(r => r[0].length));
    console.log(`${'predictor'.padEnd(width)}  ${'AUC'.padStart(6)}  ${'Brier'.padStart(6)}`);
    for (const [name, scores, probability] of table) console.log(`${name.padEnd(width)}  ${fmt(auc(scores, yj)).padStart(6)}  ${(probability ? fmt(brier(scores, yj)) : 'n/a').padStart(6)}`);
    const volatile = judged.filter(l => l.volatile);
    const hits = volatile.filter(l => (v(l).direction === 'up') === l.up).length;
    console.log(`direction on volatile rows: ${volatile.length ? `${hits}/${volatile.length} = ${pctOf(hits, volatile.length)}` : 'n/a'}`);
    const called = judged.filter(l => v(l).score >= 3), right = called.filter(l => l.volatile).length;
    console.log(`score >= 3: ${called.length} calls, precision ${pctOf(right, called.length)}, recall ${pctOf(right, volatile.length)}`);
    const early = judged.filter(l => !l.underway), earlyY = early.map(l => l.volatile), earlyVolatile = earlyY.filter(Boolean).length;
    const warned = early.filter(l => v(l).score >= WARN_MIN_SCORE && v(l).scoreConfidence >= WARN_MIN_CONFIDENCE), warnedRight = warned.filter(l => l.volatile).length;
    console.log(`early warning, rows not already moving: ${early.length} (${earlyVolatile} volatile), score AUC ${fmt(auc(early.map(l => v(l).score), earlyY))} against ${fmt(auc(early.map(l => l.moved), earlyY))} for the range covered; the page's warnings (score >= ${WARN_MIN_SCORE}, confidence >= ${WARN_MIN_CONFIDENCE}) ${warned.length}, precision ${pctOf(warnedRight, warned.length)}, recall ${pctOf(warnedRight, earlyVolatile)}`);
    const ms = judged.map(l => v(l).ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
    const tokens = judged.map(l => v(l).inputTokens).filter((x): x is number => typeof x === 'number');
    if (ms.length) console.log(`latency p50 ${ms[ms.length >> 1]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms; input tokens mean ${tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 'n/a'}`);
  }

  // The fair comparison: the same minutes for every model still answering. One with no answer over the last 24 hours of labelled minutes
  // (a paused SubQ arm) is left out, or it would hold the comparison to the minutes before it stopped; its own section above still counts.
  const newest = labelled.reduce((t, l) => Math.max(t, l.row.features.t), -Infinity);
  const answered = MODELS.filter(m => labelled.some(l => l.row.features.t > newest - 24 * 60 * MINUTE && verdictOf(l.row, m)));
  const silent = MODELS.filter(m => !answered.includes(m) && labelled.some(l => verdictOf(l.row, m)));
  const paired = labelled.filter(l => answered.every(m => verdictOf(l.row, m)));
  if (answered.length > 1 && paired.length) {
    const yp = paired.map(l => l.volatile), volatileRows = paired.filter(l => l.volatile);
    console.log(`\n== paired: ${paired.length} minutes every model answered (${volatileRows.length} volatile)${silent.length ? `; left out, silent for 24 h: ${silent.join(', ')}` : ''}`);
    for (const m of answered) {
      const right = volatileRows.filter(l => (verdictOf(l.row, m)!.direction === 'up') === l.up).length;
      console.log(`${m.padEnd(12)} score AUC ${fmt(auc(paired.map(l => verdictOf(l.row, m)!.score), yp))}, direction on volatile ${volatileRows.length ? `${right}/${volatileRows.length}` : 'n/a'}`);
    }
  }
}

type Verdict = NonNullable<Row['verdict']>;
/** Jev's verdict is the row's `verdict`, the SubQ arms' are under `arms`. */
const MODELS = ['jev', 'subq', 'subqHistory', 'subqImage'] as const;
function verdictOf(row: Row, model: typeof MODELS[number]): Verdict | undefined {
  const v = model === 'jev' ? row.verdict : row.arms?.[model];
  return v && typeof v.score === 'number' ? v : undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
