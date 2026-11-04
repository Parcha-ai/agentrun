// The few calls this server makes of Daytona's API itself, beside its provider's (pi-transport's daytonaBoxes): with
// the server's key, and never through a redirect, which would carry the key to wherever it points. The box relay
// (box-relay.ts) reads a sandbox's labels and toolbox with them; runs.ts keeps a box whose copy back is not whole (no
// auto-delete, an idle stop) and wakes a run's box that Daytona stopped or paused.

/** Daytona's API and this server's key for it (boxes.ts daytonaApi). `fetch`: for tests. */
export type DaytonaApi = { apiUrl: string; apiKey: string; fetch?: typeof fetch };

/** How long a box kept because its copy back stopped (runs.ts) runs idle before Daytona stops it: its files stay, for
 *  the next start's pull, and its compute stops. */
export const KEPT_AUTOSTOP_MINUTES = 15;

const CALL_MS = 30_000;
const WAKE_MS = 120_000;
const POLL_MS = 1_000;

/** The redirect `fetch` refused (`redirect: "error"`): said plainly, as nothing follows one. */
export function redirectRefusal(cause: unknown): string | undefined {
  const inner = (cause as { cause?: unknown } | null)?.cause;
  return /redirect/i.test(`${(cause as Error | null)?.message ?? ""} ${(inner as Error | null)?.message ?? ""}`) ? "Daytona answered with a redirect, which is never followed: it would carry the key" : undefined;
}

/** One call to Daytona's API at `path` (below its base), with the key; a redirect throws, saying so. */
export async function daytonaCall(api: DaytonaApi, method: string, path: string): Promise<Response> {
  const base = api.apiUrl.replace(/\/+$/, "");
  try {
    return await (api.fetch ?? fetch)(`${base}${path}`, { method, headers: { authorization: `Bearer ${api.apiKey}`, "x-daytona-source": "pi-transport" }, redirect: "error", signal: AbortSignal.timeout(CALL_MS) });
  } catch (error) {
    const refused = redirectRefusal(error);
    throw refused ? new Error(`${method} ${new URL(`${base}${path}`).pathname}: ${refused}`) : error;
  }
}

/** Keeps sandbox `id` with its files: Daytona's auto-delete off first (a box is made with 0, which deletes it as it
 *  stops), then its auto-stop at `minutes` without activity, so its compute stops and its disk stays. */
export async function keepWhenIdle(api: DaytonaApi, id: string, minutes = KEPT_AUTOSTOP_MINUTES): Promise<void> {
  const kept = await daytonaCall(api, "POST", `/sandbox/${encodeURIComponent(id)}/autodelete/-1`);
  if (!kept.ok) throw new Error(`Daytona answered ${kept.status} to turning off a kept box's auto-delete`);
  const stops = await daytonaCall(api, "POST", `/sandbox/${encodeURIComponent(id)}/autostop/${minutes}`);
  if (!stops.ok) throw new Error(`Daytona answered ${stops.status} to the auto-stop of a kept box`);
}

/** The states a run's box is woken from: stopped (a kept box after its idle stop) and paused (a class that pauses when
 *  idle, while its run waits for a person). `/start` takes either. */
const ASLEEP: ReadonlySet<unknown> = new Set(["stopped", "paused"]);
/** On its way to one of those: waited for (SETTLE_MS at most), then started. */
const SETTLING: ReadonlySet<unknown> = new Set(["stopping", "pausing"]);
const SETTLE_MS = 60_000;

type Listed = { id?: unknown; state?: unknown; labels?: Record<string, unknown> };

/** Starts every stopped or paused run box whose run `pick` names, and waits until each runs: a box kept at a run's end
 *  that Daytona stopped, which the start's sweep then pulls like any other, or a run's box that paused while it waited.
 *  One still stopping or pausing is waited for first; one that has not settled in SETTLE_MS throws, so its caller keeps
 *  it and never makes another in its place. How many run now. */
export async function wakeBoxes(api: DaytonaApi, pick: (runId: string) => boolean): Promise<number> {
  const stopped: string[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ labels: JSON.stringify({ "pi-transport": "1" }), limit: "100", ...(cursor ? { cursor } : {}) });
    const answer = await daytonaCall(api, "GET", `/sandbox?${query}`);
    if (!answer.ok) throw new Error(`Daytona answered ${answer.status} to the listing of its sandboxes`);
    const page = (await answer.json().catch(() => null)) as { items?: Listed[]; nextCursor?: string | null } | Listed[] | null;
    const items = Array.isArray(page) ? page : (page?.items ?? []);
    for (const item of items) {
      const run = item.labels?.["agentrun.run"];
      if (typeof item.id === "string" && (ASLEEP.has(item.state) || SETTLING.has(item.state)) && item.labels?.["agentrun.box"] === "run" && typeof run === "string" && pick(run)) stopped.push(item.id);
    }
    cursor = Array.isArray(page) ? undefined : (page?.nextCursor ?? undefined);
  } while (cursor);
  let woken = 0;
  for (const id of stopped) {
    const state = await settled(api, id);
    if (state === undefined) continue;
    woken++;
    if (state === "started") continue;
    const started = await daytonaCall(api, "POST", `/sandbox/${encodeURIComponent(id)}/start`);
    if (!started.ok) throw new Error(`Daytona answered ${started.status} to the start of a kept box`);
    for (const end = Date.now() + WAKE_MS; ; ) {
      const read = await daytonaCall(api, "GET", `/sandbox/${encodeURIComponent(id)}`);
      const state = read.ok ? ((await read.json().catch(() => null)) as Listed | null)?.state : undefined;
      if (state === "started") break;
      if (Date.now() > end) throw new Error(`a kept box did not start within ${WAKE_MS / 1000} s (state ${String(state)})`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  return woken;
}

/** Sandbox `id`'s state once it is no longer stopping or pausing; undefined when it is gone. Throws past SETTLE_MS. */
async function settled(api: DaytonaApi, id: string): Promise<unknown> {
  for (const end = Date.now() + SETTLE_MS; ; ) {
    const read = await daytonaCall(api, "GET", `/sandbox/${encodeURIComponent(id)}`);
    if (read.status === 404) return undefined;
    const state = read.ok ? ((await read.json().catch(() => null)) as Listed | null)?.state : undefined;
    if (state !== undefined && !SETTLING.has(state)) return state;
    if (Date.now() > end) throw new Error(`a run's box was still ${String(state)} after ${SETTLE_MS / 1000} s: it is kept, and nothing is made in its place`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
