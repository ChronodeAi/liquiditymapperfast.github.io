import { DatabaseSync } from 'node:sqlite';
import type { Column, ColumnStore } from './recorder.mts';
import { LT_LENGTH } from '../../shared/lt-sample.ts';

/**
 * SQLite persistence for minute columns: one row per instrument-minute, blob = bins | bid | ask. The Liquidity Tracker kept with a minute
 * (`Column.lt`, its mean over `ltN` samples) is a row of its own table, so the depth rows and their reader stay as they were (their
 * blob's length says how many bins it holds) and a minute recorded before the tracker was kept simply has none.
 */
export class SqliteColumnStore implements ColumnStore {
  readonly #db: DatabaseSync;
  readonly #insert;
  readonly #insertLt;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS depth_columns (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, step REAL NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));
      CREATE TABLE IF NOT EXISTS depth_lt (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));`);
    this.#insert = this.#db.prepare('INSERT OR REPLACE INTO depth_columns (inst, t, n, step, data) VALUES (?, ?, ?, ?, ?)');
    this.#insertLt = this.#db.prepare('INSERT OR REPLACE INTO depth_lt (inst, t, n, data) VALUES (?, ?, ?, ?)');
  }
  *load(sinceMs: number): Iterable<{ instrumentId: string; column: Column; step: number }> {
    // The tracker rows of the same minutes, by instrument and minute (a row of another length is from another layout: left out).
    const lt = new Map<string, { n: number; values: Float32Array }>();
    for (const row of this.#db.prepare('SELECT inst, t, n, data FROM depth_lt WHERE t >= ?').all(sinceMs) as Iterable<{ inst: string; t: number; n: number; data: Uint8Array }>) {
      if (row.data.byteLength !== LT_LENGTH * 4 || !(row.n > 0)) continue;
      lt.set(`${row.inst}|${row.t}`, { n: row.n, values: new Float32Array(row.data.slice().buffer) });
    }
    const rows = this.#db.prepare('SELECT inst, t, n, step, data FROM depth_columns WHERE t >= ? ORDER BY inst, t').all(sinceMs);
    for (const row of rows as Iterable<{ inst: string; t: number; n: number; step: number; data: Uint8Array }>) {
      const bytes = row.data;
      const count = bytes.byteLength / 12;
      if (!Number.isInteger(count)) continue;
      const copy = bytes.slice().buffer, tracker = lt.get(`${row.inst}|${row.t}`);
      yield { instrumentId: row.inst, step: row.step, column: {
        t: row.t, n: row.n, bins: new Int32Array(copy, 0, count), bid: new Float32Array(copy, count * 4, count), ask: new Float32Array(copy, count * 8, count),
        ...(tracker ? { lt: tracker.values, ltN: tracker.n } : {}) } };
    }
  }
  save(instrumentId: string, column: Column, step: number): void {
    const count = column.bins.length;
    const data = new Uint8Array(count * 12);
    data.set(new Uint8Array(column.bins.buffer, column.bins.byteOffset, count * 4), 0);
    data.set(new Uint8Array(column.bid.buffer, column.bid.byteOffset, count * 4), count * 4);
    data.set(new Uint8Array(column.ask.buffer, column.ask.byteOffset, count * 4), count * 8);
    this.#insert.run(instrumentId, column.t, column.n, step, data);
    if (column.lt && column.lt.length === LT_LENGTH && (column.ltN ?? 0) > 0) this.#insertLt.run(instrumentId, column.t, column.ltN!, new Uint8Array(column.lt.buffer, column.lt.byteOffset, LT_LENGTH * 4).slice());
  }
  prune(beforeMs: number): void {
    this.#db.prepare('DELETE FROM depth_columns WHERE t < ?').run(beforeMs);
    this.#db.prepare('DELETE FROM depth_lt WHERE t < ?').run(beforeMs);
  }
  close(): void { this.#db.close(); }
}
