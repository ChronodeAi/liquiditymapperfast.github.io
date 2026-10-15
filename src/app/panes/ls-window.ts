/**
 * When the Long/Short pane asks for readings, and over which window (pure, tested in tests/app-ls-window.test.mts).
 *
 * The view needs itself and half a view before it (the first step drawn begins before the view). Nothing is asked while what is held (the
 * same markets, series and timeframe) covers that and was answered less than a minute ago, nor while a round is under way (one that has not
 * answered in 30 s no longer counts). Otherwise the window asked is a view wider on each side than the view needs, so zooming and panning a
 * little ask nothing. A live view's end moving on is the minute refresh's to follow, not a new question. Asking anew on every view change
 * had a zoom send three requests a step, each up to a second and a half on the server, with the pane blank until the last (2026-10-15).
 */
export interface LsHeld { ident: string; from: number; to: number; at: number }

const MINUTE = 60_000, HOUR = 3_600_000, STALL_MS = 30_000;

/** The window to ask for now, or null when nothing need be asked. */
export function lsWindow(held: LsHeld | null, loading: boolean, ident: string, view: { t0: number; t1: number }, tfMs: number, now: number): { from: number; to: number } | null {
  const span = view.t1 - view.t0, needFrom = view.t0 - span / 2, needTo = Math.min(view.t1 + tfMs, now + tfMs);
  if (held && held.ident === ident) {
    if (loading && now - held.at < STALL_MS) return null;
    if (!loading && held.from <= needFrom && held.to >= needTo - MINUTE && now - held.at < MINUTE) return null;
  }
  return { from: Math.floor((view.t0 - 1.5 * span) / HOUR) * HOUR, to: Math.ceil(Math.min(view.t1 + span / 2 + tfMs, now + tfMs) / MINUTE) * MINUTE };
}
