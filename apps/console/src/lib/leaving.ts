import { useEffect } from "react";

/** The question a page with unsaved changes asks before the console leaves it. */
export const LEAVE_UNSAVED = "You have unsaved changes. Leave and discard them?";

// The page holding unsaved changes now, if any: one at a time, since the console shows one page.
let holder: object | null = null;

/** While `dirty`, the console asks before it leaves this page (App's hashchange, sign-out) and the browser asks before
 *  the tab closes or reloads (`beforeunload`). Clean, neither asks. */
export function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const mine = {};
    holder = mine;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => { if (holder === mine) holder = null; window.removeEventListener("beforeunload", unload); };
  }, [dirty]);
}

/** Whether the console may leave the page: yes with nothing unsaved, else the person's answer to LEAVE_UNSAVED. */
export function mayLeave(): boolean {
  return holder === null || window.confirm(LEAVE_UNSAVED);
}

/** The page's own move after a save that landed (a new agent opening its page): nothing is unsaved any more, so the
 *  console leaves without asking, before the page has drawn itself clean. */
export function leaveSaved() {
  holder = null;
}
