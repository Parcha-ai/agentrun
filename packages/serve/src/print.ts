// What the server prints on stdout: its banner at start, and one line per request, per run start and end, and per
// refused credential (logfmt: `at=<time> event=<name> key=value ...`). No line holds a token or any part of one.
import { join } from "node:path";
import type { HoldShort } from "@parcha/agentrun-kernel";

/** Where the token came from: made at this start (printed this once), kept in DIR/.token, the environment's
 *  (AGENTRUN_TOKEN), or the token list's alone (AGENTRUN_TOKENS). */
export type TokenSource = "made" | "file" | "env" | "list";

/** The banner's lines. The token is printed only when this start made it; else where it is. `publicUrl` is the address
 *  people open (AGENTRUN_PUBLIC_URL), which the base URL and the link use. With `accounts` the page is the owner's
 *  password, so its link holds nothing; with none, the link holds this start's launch code (`launchCode`), never the
 *  token. `tokenIds`: the ids of the tokens the server takes (api-token.ts), named when there is more than one or a list
 *  gave them, never a secret. `apiOnly`: no console to open, so the line says what is served instead. `shareHost`: the
 *  same, and its API is under /r/v2. `boxes`: which boxes are ready, in words (Serve's boxesLine), last. */
export function banner(o: { url: string; baseUrl: string; data: string; token: string; source: TokenSource; tokenIds?: readonly string[]; listen?: string; publicUrl?: string; accounts?: boolean; apiOnly?: boolean; shareHost?: boolean; launchCode?: string; boxes?: string }): string[] {
  const where = o.source === "env" ? "$AGENTRUN_TOKEN" : o.source === "list" ? "<a secret in $AGENTRUN_TOKENS>" : `<in ${join(o.data, ".token")}>`;
  const key = o.source === "made" ? o.token : where;
  return [
    `agentrun-serve on ${o.baseUrl} (agent store in ${o.data}${o.listen ? `, listening on ${o.listen}` : ""})`,
    `AGENTRUN_BASE_URL=${o.shareHost ? `${o.publicUrl ?? o.url}/r/v2` : o.publicUrl ? `${o.publicUrl}/v2` : o.baseUrl}`,
    `AGENTRUN_API_KEY=${key}`,
    ...(o.tokenIds && (o.tokenIds.length > 1 || o.source === "list") ? [`API tokens taken (ids): ${o.tokenIds.join(", ")}`] : []),
    o.shareHost
      ? `Share host (--share-host): shares at ${o.publicUrl ?? o.url}/r/<id>; uploads to /r/v2/shares take a token and are re-scrubbed; every other address is a 404, and no runner, model key or computer runs here.`
      : o.apiOnly
      ? "API only (AGENTRUN_API_ONLY=1): the run and deploy routes, the MCP server names, a Composio server's save and a server's delete are served; the console, sign-in, setup, other settings, the MCP endpoint, triggers and hooks are refused."
      : o.accounts || o.launchCode === undefined ? `Open ${o.publicUrl ?? o.url}/` : `Open ${o.publicUrl ?? o.url}/?launch=${o.launchCode}`,
    ...(o.boxes ? [o.boxes] : []),
  ];
}

const value = (v: string | number) => {
  const text = String(v);
  return /^[^\s"=]+$/.test(text) ? text : `"${text.replace(/[\s"]+/g, " ").trim()}"`;
};

/** One log line. */
export const logLine = (event: string, fields: Record<string, string | number> = {}): string =>
  [`at=${new Date().toISOString()}`, `event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${value(v)}`)].join(" ");

/** The warn line of a paid request whose answer billed more input than the bound its hold was priced on (the kernel's
 *  HoldShort), the cap's tripwire for a hold that was too small: `cap_hold_short` with the run, the request's session and
 *  turn, the harness, the model, the bound and what it billed in tokens, and in USD what was held and, when its answer was
 *  priced, what it billed and the shortfall (billed less held). Ids and figures only: no prompt, answer, header, key or
 *  token. */
export function holdShortLine(o: { run: string; session: string; turn: number; harness: string; model: string; boundTokens: number; billedTokens: number; heldUsd: number; billedUsd?: number }): string {
  const usd = (figure: number) => Number(figure.toFixed(6));
  return logLine("cap_hold_short", {
    run: o.run, session: o.session, turn: o.turn, harness: o.harness, model: o.model, bound_tokens: o.boundTokens, billed_tokens: o.billedTokens, held_usd: usd(o.heldUsd),
    ...(o.billedUsd === undefined ? {} : { billed_usd: usd(o.billedUsd), short_usd: usd(o.billedUsd - o.heldUsd) }),
  });
}

/** Writes `event`'s holdShortLine, when it is a booking's request_end that carries a `holdShort` (the kernel's booking,
 *  modelPortFor, tells one for a request billed past its hold's bound), to stderr with the runner's other warnings;
 *  any other event writes nothing. The one place every caller of the booking prints it (the adapter loop, a workflow
 *  run's model nodes), under `run` and `harness` (the harness, or what the booking's requests are). */
export function warnHoldShort(run: string, harness: string, event: { type: string; key: string; turn?: number; holdShort?: HoldShort }, warn: (line: string) => void = (line) => console.warn(line)): void {
  if (event.type !== "request_end" || !event.holdShort || event.turn === undefined) return;
  warn(holdShortLine({ run, session: event.key, turn: event.turn, harness, ...event.holdShort }));
}

/** The log line of a runner's start or end event (runner.ts RunnerEvent): `run_started` (run, agent, kind) once a run's
 *  first claim, `run_ended` (run, agent, status, cost_usd) once it is final: `cost_usd` the exact cost or "unknown", and
 *  beside an unknown one `cost_usd_at_most` when the run's stored cost is the most it can have cost. Any other event has
 *  none. Ids and numbers only: no token or secret reaches a line. */
export function runLine(event: { type: string; runId?: string; agent?: string; kind?: string; status?: string; costUsd?: number | null; costAtMostUsd?: number }): string | undefined {
  if (event.type === "started") return logLine("run_started", { run: event.runId!, agent: event.agent!, kind: event.kind! });
  if (event.type === "ended") return logLine("run_ended", { run: event.runId!, agent: event.agent!, status: event.status === "ended" ? "completed" : event.status!, cost_usd: event.costUsd ?? "unknown", ...(event.costAtMostUsd !== undefined ? { cost_usd_at_most: event.costAtMostUsd } : {}) });
  return undefined;
}

/** A duration as --drain-timeout takes it ("8s", "500ms", "1m"), in milliseconds; undefined when it is not one. */
export function durationMs(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text.trim());
  return m ? Math.round(Number(m[1]) * { ms: 1, s: 1_000, m: 60_000 }[m[2] as "ms" | "s" | "m"]) : undefined;
}
