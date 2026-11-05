// A faux model that reports, from inside the run's process, what it was handed: a short digest of each secret (never the
// value), the secret names still in its environment, the names (never a value) in its environment, in that of a program
// it starts, and in that of a program a tool starts with the environment its host gives it (withSecrets), and how its
// pipe went. "Hold." holds the turn until it is stopped.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { keep } from "./custody-report.mjs";

const secrets = await import(new URL("../../dist/secrets.js", import.meta.url).href);
const digest = (value) => (value === undefined ? "none" : createHash("sha256").update(value).digest("hex").slice(0, 16));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
/** The names a program started with `options` sees in its environment. */
const namesSeen = (options = {}) => spawnSync("sh", ["-c", "env"], { encoding: "utf8", ...options }).stdout.split("\n").map((line) => line.slice(0, Math.max(0, line.indexOf("=")))).filter(Boolean);

export default function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Hold.")) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  const report = {
    handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, digest(secrets.secret(name))])),
    inEnv: secrets.SECRET_NAMES.filter((name) => name in process.env),
    env: Object.keys(process.env),
    child: namesSeen(),
    toolChild: namesSeen({ env: secrets.withSecrets(process.env) }),
    pipe: secrets.handoverState() ?? null,
  };
  keep(report);
  return faux.message(JSON.stringify(report));
}
