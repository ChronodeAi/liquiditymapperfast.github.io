import { DatabaseSync } from 'node:sqlite';
import { TradeCoverage as CoverageCore, type CoverageRow, type CoverageStore, type SeamTrade, type SpanKind } from '../../shared/coverage.ts';
import { RETENTION_MS } from '../../shared/recorder.ts';

export { MAX_COVERAGE_INSTRUMENTS, MAX_COVERAGE_SPAN_MS, coverageWindow, depthAnswer, recordedMinutes, tradeAnswer, type CoverageMetric } from '../../shared/coverage.ts';

type Row = { inst: string; metric: string; t0: number; t1: number; kind: string; first_id: string | null; first_t: number | null; last_id: string | null; last_t: number | null };
const seam = (id: string | null, t: number | null): SeamTrade | undefined => id !== null && t !== null && Number.isFinite(t) ? { id, t } : undefined;

/** The coverage record's stretches in the history database, next to the minutes they say were recorded (a stretch is written again as it grows: its start is its key). */
class SqliteCoverageStore implements CoverageStore {
  readonly #db: DatabaseSync;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS coverage (inst TEXT NOT NULL, metric TEXT NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, kind TEXT NOT NULL,
      first_id TEXT, first_t INTEGER, last_id TEXT, last_t INTEGER, PRIMARY KEY (inst, metric, t0)); CREATE INDEX IF NOT EXISTS coverage_t1 ON coverage(t1);`);
  }
  *load(since: number): Iterable<CoverageRow> {
    for (const row of this.#db.prepare('SELECT inst, metric, t0, t1, kind, first_id, first_t, last_id, last_t FROM coverage WHERE t1 >= ?').all(since) as Row[]) {
      if ((row.metric !== 'trades' && row.metric !== 'depth') || (row.kind !== 'live' && row.kind !== 'recovered')) continue;
      const first = seam(row.first_id, row.first_t), last = seam(row.last_id, row.last_t);
      yield { inst: row.inst, metric: row.metric, from: row.t0, to: row.t1, kind: row.kind as SpanKind, ...(first ? { first } : {}), ...(last ? { last } : {}) };
    }
  }
  save(rows: CoverageRow[], expireBefore: number): void {
    const db = this.#db, put = db.prepare('INSERT OR REPLACE INTO coverage (inst, metric, t0, t1, kind, first_id, first_t, last_id, last_t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const r of rows) put.run(r.inst, r.metric, r.from, r.to, r.kind, r.first?.id ?? null, r.first?.t ?? null, r.last?.id ?? null, r.last?.t ?? null);
      db.prepare('DELETE FROM coverage WHERE t1 < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** The trade coverage record persisted in SQLite (`dbPath`) for the server's week, or kept in memory when there is none. */
export class TradeCoverage extends CoverageCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqliteCoverageStore(dbPath) : null, now, RETENTION_MS); }
}
