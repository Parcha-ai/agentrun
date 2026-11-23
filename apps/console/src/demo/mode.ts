// Demo mode's switch: whether this browser shows the console over sample data in place of its server's. The choice is
// this browser's alone (localStorage), so it never changes what the server holds or what another browser sees.

import { ClientError } from "@/lib/client";
import type { Upload } from "@/lib/uploads";

const KEY = "agentrun.console.demo";

/** What demo mode answers a write it does not make. */
export const DEMO_REFUSAL = "Demo mode shows sample data, so this change was not made. Turn demo mode off in Settings → Demo to work with your own server.";

/** Demo mode's upload: a picked file is refused here, before any byte leaves the page. The start screens' own upload is
 *  an XMLHttpRequest to the server, which the demo's `fetch` never sees. */
export const demoUpload: Upload = () => Promise.reject(new ClientError(403, "demo_mode", DEMO_REFUSAL));
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The choice held on this page when the browser's storage refuses it (private mode): it lasts until the page reloads. */
let held: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

/** Whether demo mode is on in this browser. */
export function demoOn(store: Store | null = local()): boolean {
  if (held !== null) return held;
  try { return store?.getItem(KEY) === "on"; } catch { return false; }
}

/** Turns demo mode on or off, here and for every page of the console that listens (`onDemoChange`). */
export function setDemo(on: boolean, store: Store | null = local()): void {
  try {
    if (on) store?.setItem(KEY, "on"); else store?.removeItem(KEY);
    held = store ? null : on;
  } catch { held = on; }
  for (const l of listeners) l(on);
}

/** Calls `listener` at each change of the switch made on this page; answers the way to stop. */
export function onDemoChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
