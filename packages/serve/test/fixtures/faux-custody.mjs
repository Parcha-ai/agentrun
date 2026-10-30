// A faux model that reports, from inside the run's process, what it was handed: a short digest of each secret (never the
// value), the secret names still in its environment, and how its pipe went. "Hold." holds the turn until it is stopped.
import { createHash } from "node:crypto";

const secrets = await import(new URL("../../dist/secrets.js", import.meta.url).href);
const digest = (value) => (value === undefined ? "none" : createHash("sha256").update(value).digest("hex").slice(0, 16));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Hold.")) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
  return faux.message(JSON.stringify({
    handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, digest(secrets.secret(name))])),
    inEnv: secrets.SECRET_NAMES.filter((name) => name in process.env),
    pipe: secrets.handoverState() ?? null,
  }));
}
