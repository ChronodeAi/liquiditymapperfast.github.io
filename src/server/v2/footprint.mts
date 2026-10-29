import { DatabaseSync } from 'node:sqlite';
import { FootprintRecorder as FootprintCore, parseStats, statsText, type FootprintMinuteRow, type FootprintStore, type StoredBin } from '../../shared/footprint.ts';
import { HOT_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { deleteMinutesBefore, keepBefore } from './keep.mts';

export { SIZE_EDGES, sizeBucket, parseStats, type TradeLike, type FootprintRow, type FootprintBar, type TradeStats } from '../../shared/footprint.ts';

/** Recorded minutes in the history database, next to the depth columns. */
export class SqliteFootprintStore implements FootprintStore {
  readonly #db: DatabaseSync;
  readonly #range;
  readonly #now: () => number;
  constructor(dbPath: string, now: () => number = Date.now) {
    this.#now = now;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS footprint_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, step REAL NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (inst, t));`);
    // Databases written before trade stats existed gain the column; their old minutes simply have none.
    if (!(this.#db.prepare('PRAGMA table_info(footprint_minutes)').all() as { name: string }[]).some(column => column.name === 'stats')) this.#db.exec('ALTER TABLE footprint_minutes ADD COLUMN stats TEXT');
    this.#range = this.#db.prepare('SELECT t, step, rows FROM footprint_minutes WHERE inst = ? AND t >= ? AND t < ? ORDER BY t');
  }
  /** One instrument's minutes in [from, to), oldest first, rows only: the recorder holds every minute's statistics in memory. */
  range(inst: string, from: number, to: number): FootprintMinuteRow[] {
    if (!(to > from)) return [];
    return (this.#range.all(inst, Math.floor(from), Math.ceil(to)) as { t: number; step: number; rows: string }[])
      .map(row => ({ inst, t: row.t, step: row.step, bins: JSON.parse(row.rows) as StoredBin[], stats: null }));
  }
  *load(since: number): Iterable<FootprintMinuteRow> {
    for (const row of this.#db.prepare('SELECT inst, t, step, rows, stats FROM footprint_minutes WHERE t >= ?').all(since) as { inst: string; t: number; step: number; rows: string; stats: string | null }[])
      yield { inst: row.inst, t: row.t, step: row.step, bins: JSON.parse(row.rows) as [number, number, number][], stats: parseStats(row.stats) };
  }
  save(rows: FootprintMinuteRow[], expireBefore: number): void {
    const db = this.#db, insert = db.prepare('INSERT OR REPLACE INTO footprint_minutes (inst, t, step, rows, stats) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row.inst, row.t, row.step, JSON.stringify(row.bins), row.stats ? statsText(row.stats) : null);
      deleteMinutesBefore(db, 'footprint_minutes', keepBefore(expireBefore, this.#now()));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/**
 * The footprint recorder persisted in SQLite (`dbPath`), or kept in memory when there is none. A day of its rows is held in memory and older
 * ones are read back when a question reaches them (`memoryMs`; HOT_MS by default).
 */
export class FootprintRecorder extends FootprintCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now, memoryMs: number = HOT_MS) { super(dbPath ? new SqliteFootprintStore(dbPath, now) : null, now, RETENTION_MS, 1, memoryMs); }
}
