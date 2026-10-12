// Fitting the small model's answer to the big centre view. Pure: the page hands in a function that measures the content's height at a given type scale; this finds the largest scale (at
// most 1, the designed size) at which it fits the room. Below MIN_TALK_SCALE the type would be too small to read from a distance, so an answer that still does not fit is cut instead, with
// a visible mark (the page's job), and what stays on screen is the END of the answer.
export const MIN_TALK_SCALE = 0.4;

export function chooseScale(measure: (scale: number) => number, room: number): { scale: number; fits: boolean } {
  if (!Number.isFinite(room) || room <= 0) return { scale: MIN_TALK_SCALE, fits: false };
  const at = (s: number) => {
    const h = measure(s);
    return Number.isFinite(h) ? h : Infinity;
  };
  if (at(1) <= room) return { scale: 1, fits: true };
  if (at(MIN_TALK_SCALE) > room) return { scale: MIN_TALK_SCALE, fits: false };
  let lo = MIN_TALK_SCALE; // fits
  let hi = 1; // does not
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) <= room) lo = mid;
    else hi = mid;
  }
  // Rounded DOWN to three decimals: `lo` fits, so a smaller scale fits too (the content only grows with the type size), while rounding to the nearest could land above the room.
  return { scale: Math.max(MIN_TALK_SCALE, Math.floor(lo * 1000) / 1000), fits: true };
}
