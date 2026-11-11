// Why a run's browser is not up while the run is still going, for GET /v2/runs/{run_id}/computer's `none`: the browser
// was let go while the run waited for its person (browser-person.ts personHands.wait ends with a timeline row saying so),
// and the run has opened none since. The Screen tab says that, with when, instead of waiting for a browser nobody is
// opening.
//
// One small server setting per run holds it (`browser_wait_ended:<run id>`: { at, why }), written by the run's process as
// the wait ends and removed as any browser session of the run opens, whatever let the old one go (its idle release, the
// tool, a close at the park). So a Screen poll, every few seconds on a parked run, reads one row, never the run's journal.

/** The store seam: the server's settings (store/store.ts Settings), the three calls this uses. */
export type WaitEndedSettings = {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

/** A browser let go while its run waited for its person: when (ISO) and the timeline row's words. */
export type WaitEnded = { at: string; why: string };

const keyOf = (runId: string) => `browser_wait_ended:${runId}`;

/** The run's process, as its wait ends with the browser let go: kept for the Screen tab. */
export async function markWaitEnded(settings: WaitEndedSettings, runId: string, ended: WaitEnded): Promise<void> {
  await settings.put(keyOf(runId), ended);
}

/** The run's process, as any browser session of the run opens: nothing ended any more. */
export async function clearWaitEnded(settings: WaitEndedSettings, runId: string): Promise<void> {
  await settings.remove(keyOf(runId));
}

/** The server's Screen read: for a run that has ended, nothing, and its row goes (a run that ended with no browser after
 *  the wait leaves none behind: the runner removes it at the end too, this catches any end that didn't); for a going
 *  run, the ended state. */
export async function screenWaitEnded(settings: WaitEndedSettings, runId: string, terminal: boolean): Promise<WaitEnded | undefined> {
  if (terminal) {
    await settings.remove(keyOf(runId)).catch(() => undefined);
    return undefined;
  }
  return readWaitEnded(settings, runId);
}

/** The ended state, or undefined. One settings read; a value of another shape is no ended state. */
export async function readWaitEnded(settings: Pick<WaitEndedSettings, "get">, runId: string): Promise<WaitEnded | undefined> {
  const value = await settings.get(keyOf(runId));
  if (!value || typeof value !== "object") return undefined;
  const { at, why } = value as { at?: unknown; why?: unknown };
  return typeof at === "string" && typeof why === "string" ? { at, why } : undefined;
}
