/** Back, as a page's back arrow takes it: to the console page the person came from when there is one, else to `fallback`.
 *  The console numbers each history entry it moves through (`console_at` in history.state, kept by the browser across
 *  back, forward and reload), so an entry numbered above 0 has one of the console's own before it. An address opened
 *  from elsewhere (a link, a new tab) is numbered 0: its entry before is another site's, or none, and Back opens
 *  `fallback` instead of leaving the console. */
let at = 0;
const numbered = (): number | undefined => {
  const n = (history.state as { console_at?: unknown } | null)?.console_at;
  return typeof n === "number" ? n : undefined;
};
const mark = (n: number) => { at = n; history.replaceState({ ...(history.state ?? {}), console_at: n }, ""); };

/** Numbers this entry and each one the console moves to after it; answers the listener's removal. */
export function trackHistory(): () => void {
  const here = numbered();
  if (here === undefined) mark(0); else at = here;
  // A new entry (a link, `location.hash = ...`) has no number yet: one more than the entry it came from. One moved back
  // or forward to has its own.
  const on = () => { const n = numbered(); if (n === undefined) mark(at + 1); else at = n; };
  window.addEventListener("hashchange", on);
  return () => window.removeEventListener("hashchange", on);
}

/** Takes back the move the address just made (a link followed, back or forward, an address typed), back to the entry it
 *  left. Called from a hashchange listener that runs before trackHistory's has counted the move: a new entry (no number
 *  yet) is one step back; an entry moved to is as many steps as it is from the one left. */
export function undoMove() {
  const n = numbered();
  const steps = n === undefined ? -1 : at - n;
  // go(0) reloads the page, the very thing a held move keeps from happening.
  if (steps !== 0) history.go(steps);
}

export function goBack(fallback: string) {
  if (at > 0) history.back();
  else location.hash = fallback;
}
