/**
 * `text` as it is when it fits `max` px, else its longest start that fits with an ellipsis after it. `measure` is a canvas context's text width
 * in the font it is about to draw with; the cut is found by halving, so a long text costs a handful of measurements, not one per letter.
 */
export function fitText(measure: (text: string) => number, text: string, max: number): string {
  if (!text || measure(text) <= max) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= max) low = mid; else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low).trimEnd()}…` : '…';
}
