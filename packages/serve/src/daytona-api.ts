// The few calls this server makes of Daytona's API itself, beside its provider's (pi-transport's daytonaBoxes): with
// the server's key, and never through a redirect, which would carry the key to wherever it points. The box relay
// (box-relay.ts) reads a sandbox's labels and toolbox with them; runs.ts stops a kept box when it is idle and wakes it
// at the next start.

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

/** Sets sandbox `id` to stop after `minutes` without activity (Daytona's auto-stop). */
export async function stopWhenIdle(api: DaytonaApi, id: string, minutes = KEPT_AUTOSTOP_MINUTES): Promise<void> {
  const answer = await daytonaCall(api, "POST", `/sandbox/${encodeURIComponent(id)}/autostop/${minutes}`);
  if (!answer.ok) throw new Error(`Daytona answered ${answer.status} to the auto-stop of a kept box`);
}

type Listed = { id?: unknown; state?: unknown; labels?: Record<string, unknown> };

/** Starts every stopped run box whose run `ended` says is over (a box kept because its copy back stopped, which Daytona
 *  stopped once it was idle), and waits until each runs: the start's sweep then pulls it like any other. How many. */
export async function wakeStopped(api: DaytonaApi, ended: (runId: string) => boolean): Promise<number> {
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
      if (typeof item.id === "string" && item.state === "stopped" && item.labels?.["agentrun.box"] === "run" && typeof run === "string" && ended(run)) stopped.push(item.id);
    }
    cursor = Array.isArray(page) ? undefined : (page?.nextCursor ?? undefined);
  } while (cursor);
  for (const id of stopped) {
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
  return stopped.length;
}
