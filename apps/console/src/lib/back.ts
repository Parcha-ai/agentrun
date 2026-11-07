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

export function goBack(fallback: string) {
  if (at > 0) history.back();
  else location.hash = fallback;
}

/** Takes back a move the console refused (App's guard on unsaved changes, after the browser already moved): back to the
 *  entry the console was at, never a rewrite of one. A step to a numbered entry (the browser's Back or Forward) is undone
 *  by the same number of steps the other way; a new entry (a link, an address) by one step back, which leaves it ahead in
 *  the history, as a page the person may still go Forward to. Call it before `trackHistory`'s listener sees the move. */
export function undoMove() {
  const n = numbered();
  history.go(n === undefined ? -1 : at - n);
}
