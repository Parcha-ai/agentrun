// A faux model that reports, from inside the run's process, what it was handed: a short digest of each secret (never the
// value), the secret names still in its environment, the names shaped like a key in its environment and in that of a
// program it starts (names only, never a value), and how its pipe went. "Hold." holds the turn until it is stopped.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const secrets = await import(new URL("../../dist/secrets.js", import.meta.url).href);
const digest = (value) => (value === undefined ? "none" : createHash("sha256").update(value).digest("hex").slice(0, 16));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
/** The names shaped like a key, by the rule the server's cuts take (secret-cut.ts). */
const keyShaped = (names) => names.filter((name) => /(_API_KEY|_TOKEN)$|SECRET/i.test(name));

export default function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Hold.")) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  // A program this process starts gets its environment, as a tool's command would: the names it shows.
  const child = spawnSync("sh", ["-c", "env"], { encoding: "utf8" }).stdout.split("\n").map((line) => line.slice(0, Math.max(0, line.indexOf("="))));
  return faux.message(JSON.stringify({
    handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, digest(secrets.secret(name))])),
    inEnv: secrets.SECRET_NAMES.filter((name) => name in process.env),
    keyShaped: keyShaped(Object.keys(process.env)),
    child: keyShaped(child.filter(Boolean)),
    pipe: secrets.handoverState() ?? null,
  }));
}
