// The composer's hint on one line. A textarea's placeholder cannot take `text-overflow: ellipsis` (the computed value stays "clip"), so a hint that is too long for the field is cut here, to the width the
// field has, with an ellipsis. Pure: `measure` says how wide a text is (the page gives it a canvas's).

/** `text` if it fits in `maxPx`, else the longest beginning of it that fits with "…" after it. */
export function ellipsize(text: string, maxPx: number, measure: (s: string) => number): string {
  if (measure(text) <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo).trimEnd()}…`;
}
