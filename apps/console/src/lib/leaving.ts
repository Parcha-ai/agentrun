import { useCallback, useEffect, useRef } from "react";

/** The question a page with unsaved changes asks before the console leaves it. */
export const LEAVE_UNSAVED = "You have unsaved changes. Leave and discard them?";

// The page holding unsaved changes now, if any: one at a time, since the console shows one page. Each page's guard is
// its own token, so only that page can lift it.
let holder: object | null = null;

/** While `dirty`, the console asks before it leaves this page (App's hashchange, sign-out) and the browser asks before
 *  the tab closes or reloads (`beforeunload`). Clean, neither asks. Answers the page's own `leaveSaved`. */
export function useLeaveGuard(dirty: boolean): () => void {
  const token = useRef<object | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const mine = {};
    holder = mine; token.current = mine;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => { if (holder === mine) holder = null; if (token.current === mine) token.current = null; window.removeEventListener("beforeunload", unload); };
  }, [dirty]);
  return useCallback(() => leaveSaved(token.current), []);
}

/** Whether the console may leave the page: yes with nothing unsaved, else the person's answer to LEAVE_UNSAVED. */
export function mayLeave(): boolean {
  return holder === null || window.confirm(LEAVE_UNSAVED);
}

/** A page's own move after its save landed (a new agent opening its page): nothing of its own is unsaved any more, so the
 *  console leaves it without asking, before it has drawn itself clean. Lifts that page's guard only (`token`, its own),
 *  never another page's: a save that answers after its page is gone lifts nothing. */
export function leaveSaved(token: object | null) {
  if (token !== null && holder === token) holder = null;
}
