// What the server prints on stdout: its banner at start, and one line per request, per run start and end, and per
// refused credential (logfmt: `at=<time> event=<name> key=value ...`). No line holds a token or any part of one.
import { join } from "node:path";

/** Where the token came from: made at this start (printed this once), kept in DIR/.token, or the environment's. */
export type TokenSource = "made" | "file" | "env";

/** The banner's lines. The token is printed only when this start made it; else where it is. */
export function banner(o: { url: string; baseUrl: string; data: string; token: string; source: TokenSource; listen?: string }): string[] {
  const where = o.source === "env" ? "$AGENTRUN_TOKEN" : `<in ${join(o.data, ".token")}>`;
  const key = o.source === "made" ? o.token : where;
  return [
    `agentrun-serve on ${o.baseUrl} (agent store in ${o.data}${o.listen ? `, listening on ${o.listen}` : ""})`,
    `AGENTRUN_BASE_URL=${o.baseUrl}`,
    `AGENTRUN_API_KEY=${key}`,
    // Encoded: a "+" in a token reads as a space in a query string.
    `Open ${o.url}/?token=${o.source === "made" ? encodeURIComponent(o.token) : where}`,
  ];
}

const value = (v: string | number) => {
  const text = String(v);
  return /^[^\s"=]+$/.test(text) ? text : `"${text.replace(/[\s"]+/g, " ").trim()}"`;
};

/** One log line. */
export const logLine = (event: string, fields: Record<string, string | number> = {}): string =>
  [`at=${new Date().toISOString()}`, `event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${value(v)}`)].join(" ");

/** A duration as pi-durable-disk's --drain-timeout takes it ("8s", "500ms", "1m"), in milliseconds; undefined when it is not one. */
export function durationMs(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text.trim());
  return m ? Math.round(Number(m[1]) * { ms: 1, s: 1_000, m: 60_000 }[m[2] as "ms" | "s" | "m"]) : undefined;
}
