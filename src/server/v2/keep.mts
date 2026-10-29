import type { DatabaseSync } from 'node:sqlite';

/**
 * How long the server's SQLite stores keep rows on disk. Memory, startup loads, the page's windows, the span caps and the recovery window
 * stay at the recorders' own week (`RETENTION_MS` and the constants beside it): a store that deleted what was older than its week deletes
 * what is older than this (`keepBefore`), and everything that reads a store back is bounded by its week as before.
 */
const DAY_MS = 86_400_000;
const DEFAULT_DISK_DAYS = 30, MIN_DISK_DAYS = 7, MAX_DISK_DAYS = 365;

/** Days of `LMF_DISK_RETENTION_DAYS` as an integer from 7 to 365; anything else (unset, empty, 6, 366, 12.5, "abc") is the default, 30. */
export function diskRetentionMs(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  const days = /^\d+$/.test(text) ? Number(text) : NaN;
  return (Number.isSafeInteger(days) && days >= MIN_DISK_DAYS && days <= MAX_DISK_DAYS ? days : DEFAULT_DISK_DAYS) * DAY_MS;
}

export const DISK_RETENTION_MS = diskRetentionMs(process.env.LMF_DISK_RETENTION_DAYS);

/** The cutoff a store deletes before: the recorder's own (`cutoff`, a week back) or, when that is more recent, what the disk retention allows. */
export function keepBefore(cutoff: number, now = Date.now()): number { return Math.min(cutoff, now - DISK_RETENTION_MS); }

/** Rows a statement deletes at most: each statement stays short, the loop below runs until one deletes fewer. */
export const DELETE_BATCH = 5_000;

type MinuteTable = 'footprint_minutes' | 'flow_minutes' | 'absorption_minutes';

/**
 * Delete `table`'s rows before `cutoff` (its time column, `t`), instrument by instrument: the tables are keyed (inst, t) with no index on `t`
 * alone, so `DELETE ... WHERE t < ?` read every row of them. Each instrument is found by one step along the key from the one before (as
 * `SqliteAbsorptionStore.instruments` does), and its old rows by a seek on the key, at most `batch` of them to a statement. Returns the rows deleted.
 */
export function deleteMinutesBefore(db: DatabaseSync, table: MinuteTable, cutoff: number, batch = DELETE_BATCH): number {
  const next = db.prepare(`SELECT MIN(inst) AS inst FROM ${table} WHERE inst > ?`);
  const drop = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE inst = ? AND t < ? LIMIT ?)`);
  const first = db.prepare(`SELECT MIN(inst) AS inst FROM ${table}`).get() as { inst: string | null };
  let deleted = 0, inst = first.inst;
  while (inst !== null) {
    let n: number;
    do { n = Number(drop.run(inst, cutoff, batch).changes); deleted += n; } while (n >= batch);
    const after = next.get(inst) as { inst: string | null };
    inst = after.inst;
  }
  return deleted;
}
