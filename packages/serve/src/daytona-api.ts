// The few calls this server makes of Daytona's API itself, beside its provider's (pi-transport's daytonaBoxes): with
// the server's key, and never through a redirect, which would carry the key to wherever it points. The box relay
// (box-relay.ts) reads a sandbox's labels and toolbox with them.

/** Daytona's API and this server's key for it (boxes.ts daytonaApi). `fetch`: for tests. */
export type DaytonaApi = { apiUrl: string; apiKey: string; fetch?: typeof fetch };

const CALL_MS = 30_000;

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

