// What the server prints on stdout: its banner at start, and one line per request, per run start and end, and per
// refused credential (logfmt: `at=<time> event=<name> key=value ...`). No line holds a token or any part of one.
import { join } from "node:path";

/** Where the token came from: made at this start (printed this once), kept in DIR/.token, or the environment's. */
export type TokenSource = "made" | "file" | "env";

/** The banner's lines. The token is printed only when this start made it; else where it is. `publicUrl` is the address
 *  people open (AGENTRUN_PUBLIC_URL), which the base URL and the link use. With `accounts` the page is the owner's
 *  password, so its link holds nothing; with none, the link holds this start's launch code (`launchCode`), never the
 *  token. `apiOnly`: no console to open, so the line says what is served instead. `boxes`: which boxes are ready, in
 *  words (Serve's boxesLine), last. */
export function banner(o: { url: string; baseUrl: string; data: string; token: string; source: TokenSource; listen?: string; publicUrl?: string; accounts?: boolean; apiOnly?: boolean; launchCode?: string; boxes?: string }): string[] {
  const where = o.source === "env" ? "$AGENTRUN_TOKEN" : `<in ${join(o.data, ".token")}>`;
  const key = o.source === "made" ? o.token : where;
  return [
    `agentrun-serve on ${o.baseUrl} (agent store in ${o.data}${o.listen ? `, listening on ${o.listen}` : ""})`,
    `AGENTRUN_BASE_URL=${o.publicUrl ? `${o.publicUrl}/v2` : o.baseUrl}`,
    `AGENTRUN_API_KEY=${key}`,
    o.apiOnly
      ? "API only (AGENTRUN_API_ONLY=1): the run routes are served; the console, sign-in, setup, settings, MCP, triggers and hooks are refused."
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

/** The log line of a runner's start or end event (runner.ts RunnerEvent): `run_started` (run, agent, kind) once a run's
 *  first claim, `run_ended` (run, agent, status, cost_usd) once it is final. Any other event has none. Ids and numbers
 *  only: no token or secret reaches a line. */
export function runLine(event: { type: string; runId?: string; agent?: string; kind?: string; status?: string; costUsd?: number | null }): string | undefined {
  if (event.type === "started") return logLine("run_started", { run: event.runId!, agent: event.agent!, kind: event.kind! });
  if (event.type === "ended") return logLine("run_ended", { run: event.runId!, agent: event.agent!, status: event.status === "ended" ? "completed" : event.status!, cost_usd: event.costUsd ?? "unknown" });
  return undefined;
}

/** A duration as --drain-timeout takes it ("8s", "500ms", "1m"), in milliseconds; undefined when it is not one. */
export function durationMs(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text.trim());
  return m ? Math.round(Number(m[1]) * { ms: 1, s: 1_000, m: 60_000 }[m[2] as "ms" | "s" | "m"]) : undefined;
}
