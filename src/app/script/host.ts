import type { BarInputs } from './inputs.ts';
import { transferables } from './inputs.ts';
import type { RunRequest, RunResponse, ScriptJob, ScriptResult } from './protocol.ts';

/**
 * The page's side of the script worker: one run at a time, the newest request waiting behind it (an older waiting one is dropped, its answer
 * would be stale), and a deadline. A script that loops is stopped by its own step budget inside the worker; a run that still does not answer
 * in time (a script that fills memory, a worker that hung) has its worker ended and a fresh one started, and every script of it is reported
 * as stopped. The worker never sees the page: it gets the inputs and the scripts' texts, and answers with what to draw.
 */

/** What the host needs of a worker (a real `Worker`, or a test's stand-in). */
export interface WorkerLike {
  postMessage(message: RunRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: RunResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface HostOptions {
  spawn: () => WorkerLike;
  /** How long a run may take before its worker is ended (ms). */
  deadlineMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class ScriptHost {
  #worker: WorkerLike | null = null;
  #seq = 0;
  #running: { seq: number; jobs: ScriptJob[]; timer: unknown; resolve: (r: ScriptResult[]) => void } | null = null;
  #waiting: { jobs: ScriptJob[]; inputs: BarInputs; resolve: (r: ScriptResult[]) => void } | null = null;
  readonly #o: Required<HostOptions>;
  /** How many workers were ended for running over their deadline. */
  restarts = 0;

  constructor(o: HostOptions) {
    this.#o = { deadlineMs: 4_000, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>), ...o };
  }

  /** Whether a run is under way. */
  get busy(): boolean { return this.#running !== null; }

  /** Run `jobs` over `inputs` (the arrays are handed over: do not use them after). Resolves with one result per job; a request overtaken by a newer one before it started resolves with none. */
  run(jobs: ScriptJob[], inputs: BarInputs): Promise<ScriptResult[]> {
    return new Promise(resolve => {
      if (this.#running) { this.#waiting?.resolve([]); this.#waiting = { jobs, inputs, resolve }; return; }
      this.#start(jobs, inputs, resolve);
    });
  }

  #ensure(): WorkerLike {
    if (this.#worker) return this.#worker;
    const w = this.#o.spawn();
    w.onmessage = e => this.#answer(e.data);
    // A worker that fails to load or throws outside a run answers nothing: the run is ended as one over its deadline would be.
    w.onerror = () => { if (this.#running) this.#stop('worker-failed'); };
    return this.#worker = w;
  }

  #start(jobs: ScriptJob[], inputs: BarInputs, resolve: (r: ScriptResult[]) => void): void {
    const seq = ++this.#seq;
    const timer = this.#o.setTimer(() => this.#stop('timeout'), this.#o.deadlineMs);
    this.#running = { seq, jobs, timer, resolve };
    try { this.#ensure().postMessage({ t: 'run', seq, jobs, inputs }, transferables(inputs)); }
    catch { this.#stop('worker-failed'); }
  }

  #answer(msg: RunResponse): void {
    const run = this.#running;
    if (!run || msg.t !== 'result' || msg.seq !== run.seq) return;
    this.#o.clearTimer(run.timer);
    this.#running = null;
    const byId = new Map(msg.results.map(r => [r.id, r]));
    run.resolve(run.jobs.map(j => byId.get(j.id) ?? { id: j.id, ok: false, error: { code: 'no-answer', line: 0, col: 0 } }));
    this.#next();
  }

  /** End the worker of the run under way: every script of it is reported stopped, and the next run gets a fresh worker. */
  #stop(code: 'timeout' | 'worker-failed'): void {
    const run = this.#running; if (!run) return;
    this.#o.clearTimer(run.timer);
    this.#running = null;
    this.#worker?.terminate(); this.#worker = null; this.restarts++;
    run.resolve(run.jobs.map(j => ({ id: j.id, ok: false, error: { code, line: 0, col: 0 } })));
    this.#next();
  }

  #next(): void {
    const w = this.#waiting; if (!w) return;
    this.#waiting = null;
    this.#start(w.jobs, w.inputs, w.resolve);
  }

  /** End the worker and drop what waits (the page is closing the feature). */
  dispose(): void {
    if (this.#running) { this.#o.clearTimer(this.#running.timer); this.#running.resolve([]); this.#running = null; }
    this.#waiting?.resolve([]); this.#waiting = null;
    this.#worker?.terminate(); this.#worker = null;
  }
}
