import type { FlowSeries } from '../../shared/flow.ts';

/** How long a line's end may go undrawn and still be compared with what it showed (ms): after a longer pause it starts afresh. */
export const END_GAP_MS = 5_000;

/** A line's end as it was last drawn: the newest second its series held, that second's own delta then, and when it was drawn (ms). */
export interface FlowEnd { sec: number; own: number; at: number }

/**
 * What a line's running delta did at its live edge since it was last drawn (`before`): the delta of the seconds from the last one seen on,
 * less what that second already held then. Only differences of the series are read, never its running total: a history load restarts the
 * running delta at an older start (`FlowSeries.load`), which moves every total by the net of the stretch it added and none of these.
 * Nothing counts on the first drawing, after a pause of more than END_GAP_MS (the column or the page hidden: what came meanwhile is not
 * new now), or when the series no longer holds the second seen (cleared or started again). `end` is what to keep for the next drawing.
 */
export function flowEndChange(series: Pick<FlowSeries, 'span' | 'delta'>, before: FlowEnd | undefined, now: number): { end: FlowEnd | null; change: number } {
  const span = series.span;
  if (!span) return { end: null, change: 0 };
  const end: FlowEnd = { sec: span.last, own: series.delta(span.last, span.last), at: now };
  if (!before || now - before.at > END_GAP_MS || before.sec < span.first || before.sec > span.last) return { end, change: 0 };
  return { end, change: series.delta(before.sec, span.last) - before.own };
}
