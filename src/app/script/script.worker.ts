import { runScript } from './lang/engine.ts';
import type { RunRequest, RunResponse, ScriptResult } from './protocol.ts';

/**
 * The scripts' own thread: it runs each script of a request over the inputs it was handed and answers with what to draw. It reads nothing
 * else: no network, no storage, no page. A script that throws is answered as an error; the page ends this worker when a run takes too long.
 */

const scope = self as unknown as { postMessage(message: RunResponse, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<RunRequest>) => void) | null };

scope.onmessage = event => {
  const req = event.data;
  if (!req || req.t !== 'run') return;
  const results: ScriptResult[] = [];
  for (const job of req.jobs) {
    try { results.push(runScript(job.id, job.source, job.options, req.inputs)); }
    catch { results.push({ id: job.id, ok: false, error: { code: 'internal', line: 0, col: 0 } }); }
  }
  const transfer = new Set<ArrayBuffer>();
  for (const r of results) if (r.ok) for (const p of r.plots) for (const f of Object.values(p.fields)) transfer.add(f.buffer as ArrayBuffer);
  scope.postMessage({ t: 'result', seq: req.seq, results }, [...transfer]);
};

// Loaded: the page starts a run's clock only from here, so the time a worker takes to load is never taken for a script that runs too long.
scope.postMessage({ t: 'ready' });
