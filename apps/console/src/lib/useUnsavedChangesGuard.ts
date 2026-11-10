import { useEffect, useRef, useState } from "react";

/** The page holding the console's moves while it has unsaved changes: answers whether a move to `to` waits for the
 *  person (it asks them), or goes. One page at a time holds; none, and every move goes. */
let holder: ((to: string) => boolean) | null = null;

/** Whether a move to the address `to` waits on a page's unsaved changes. The console's router asks this before it moves
 *  (its `go`) and when the address has moved under it (a link, back or forward, an address typed): a held move does not
 *  open its page, and the page asks "Leave without saving?". */
export function holdsMove(to: string): boolean {
  return holder ? holder(to) : false;
}

/** Guards a page's unsaved changes while `dirty`: a move to another console address asks first (`asking`; `stay` keeps
 *  the page and its edits, `leave` makes the move and drops them), and closing or reloading the tab, or opening another
 *  site's address, gets the browser's own prompt (beforeunload). Clean, nothing is held and nothing is asked. */
export function useUnsavedChangesGuard(dirty: boolean): { asking: boolean; stay: () => void; leave: () => void } {
  const [to, setTo] = useState<string | null>(null);
  // The page's own address, as it opened: a move to it (the router taking back a move it held) is no move away.
  const here = useRef(location.hash);
  useEffect(() => {
    if (!dirty) return;
    const hold = (next: string) => { if (next === here.current) return false; setTo(next); return true; };
    holder = hold;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => { if (holder === hold) holder = null; window.removeEventListener("beforeunload", unload); };
  }, [dirty]);
  return {
    asking: to !== null,
    stay: () => setTo(null),
    leave: () => {
      if (to === null) return;
      // The move the person chose goes past the hold: nothing holds until the page next renders, and by then it is gone.
      holder = null;
      setTo(null);
      location.hash = to;
    },
  };
}
