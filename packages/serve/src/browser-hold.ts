// Whether the owner drives a run's browser now, for the run read's `computer.state` (`taken_over`) and so for Running now's
// "You drive". A browser is taken over in its live view, in the run's process (browser-person.ts personHands.take), not
// through the server's command rows as a desktop or a phone is (computer-commands.ts), so the server learns it from one
// small setting per run (`browser_hold:<run id>`: { session, at, epoch }), as it learns an ended wait
// (browser-wait-ended.ts). The run's process writes it as a take goes live and removes it as the take ends, however it
// ends, one change after another (browserHoldWriter); it removes any row an earlier process of the run left as it
// starts, since its viewers start with nobody holding the browser, so a take a crashed process never ended is not read as
// still in force. The runner removes it at the run's end.

import type { WaitEndedSettings } from "./browser-wait-ended.js";

/** A take of the run's browser in force: the session's tag and when it went live (ISO). */
export type BrowserHeld = { session: string; at: string };

const keyOf = (runId: string) => `browser_hold:${runId}`;
/** The settings key a run's browser take is kept under (the run's delete removes it: server.ts). */
export const browserHoldKey = keyOf;

/** The run's process, as a take of its browser goes live. */
export async function markBrowserHeld(settings: WaitEndedSettings, runId: string, held: BrowserHeld, epoch?: number): Promise<void> {
  await settings.put(keyOf(runId), epoch === undefined ? held : { ...held, epoch });
}

/** The run's process, as a take ends (given back, idle, away, the cap, the session gone, an answered ask), as a browser
 *  session opens, or at the run's end. Given the claim's `epoch`, a take a later claim wrote stays. Given `session`, only
 *  that session's take goes (another session's take, live meanwhile, stays). */
export async function clearBrowserHeld(settings: WaitEndedSettings, runId: string, epoch?: number, session?: string): Promise<void> {
  if (epoch !== undefined || session !== undefined) {
    const written = (await settings.get(keyOf(runId))) as { epoch?: unknown; session?: unknown } | undefined;
    if (!written) return;
    if (epoch !== undefined && typeof written.epoch === "number" && written.epoch > epoch) return;
    if (session !== undefined && written.session !== session) return;
  }
  await settings.remove(keyOf(runId));
}

/** Whether the owner holds the run's browser now: one settings read; a value of another shape is no take. */
export async function browserHeld(settings: Pick<WaitEndedSettings, "get">, runId: string): Promise<boolean> {
  const value = await settings.get(keyOf(runId));
  if (!value || typeof value !== "object") return false;
  const { session, at } = value as { session?: unknown; at?: unknown };
  return typeof session === "string" && typeof at === "string";
}

/** The run's process's writes of its browser's take, each after the one before it, so a quick take and hand-back can never
 *  land backward (the hand-back's removal reading before the take's write is in). The first removes any take an earlier
 *  process of the run left: this process's viewers start with nobody holding the browser. A write that fails leaves the
 *  ones after it to run. */
export function browserHoldWriter(settings: WaitEndedSettings, runId: string, epoch?: number): { held(tag: string, on: boolean, at: number): Promise<void> } {
  let last: Promise<void> = clearBrowserHeld(settings, runId, epoch).catch(() => undefined);
  return {
    held: (tag, on, at) => (last = last.then(() => (on ? markBrowserHeld(settings, runId, { session: tag, at: new Date(at).toISOString() }, epoch) : clearBrowserHeld(settings, runId, epoch, tag))).catch(() => undefined)),
  };
}
