import { useEffect, useRef, useState } from "react";

/** A move held for the person's answer: the address it goes to, and how to make it (`replay`; else the address is set). */
type Held = { to: string; replay?: () => void };

/** The page holding the console's moves while it has unsaved changes: answers whether a move waits for the person (it
 *  asks them), or goes. One page at a time holds; none, and every move goes. */
let holder: ((move: Held) => boolean) | null = null;

/** Whether a move to the address `to` waits on a page's unsaved changes. The console's router asks this before it moves
 *  (its `go`), and when the address has moved under it (a link, back or forward, an address typed), with `replay`, which
 *  makes that move again once the router has taken it back. A held move does not open its page, and the page asks
 *  "Leave without saving?". */
export function holdsMove(to: string, replay?: () => void): boolean {
  return holder ? holder({ to, replay }) : false;
}

/** Guards a page's unsaved changes while `dirty`: a move to another console address asks first (`asking`; `stay` keeps
 *  the page and its edits, `leave` makes the move and drops them), and closing or reloading the tab, or opening another
 *  site's address, gets the browser's own prompt (beforeunload). Clean, nothing is held and nothing is asked. */
export function useUnsavedChangesGuard(dirty: boolean): { asking: boolean; stay: () => void; leave: () => void } {
  const [held, setHeld] = useState<Held | null>(null);
  // The page's own address, as it opened: a move to it (the router taking back a move it held) is no move away.
  const here = useRef(location.hash);
  useEffect(() => {
    if (!dirty) return;
    const hold = (move: Held) => { if (move.to === here.current) return false; setHeld(move); return true; };
    holder = hold;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);
    return () => { if (holder === hold) holder = null; window.removeEventListener("beforeunload", unload); };
  }, [dirty]);
  return {
    asking: held !== null,
    stay: () => setHeld(null),
    leave: () => {
      if (held === null) return;
      // The move the person chose goes past the hold: nothing holds again on this page (its hold is set only when it turns
      // dirty), and the move takes the page away.
      holder = null;
      setHeld(null);
      if (held.replay) held.replay();
      else location.hash = held.to;
    },
  };
}
