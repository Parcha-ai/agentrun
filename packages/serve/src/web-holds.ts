// The server's keyless holds: a keyless provider's limit a run met holds that provider for the whole host (its allowance
// is the host's, not the run's), in the server's memory alone, until it lifts or the server restarts. Each new run's Web
// starts with them (webOf; a run's own process gets them in its spawn environment, holdsEnv: hold data alone, never a
// key), and GET /capabilities reads them live. A run's own process hands each hold it meets back over its channel
// (reportHold, run-child.ts); the server is their one writer. A keyed provider's hold stays the run's own.
import { type Hold, holdingWords, isProviderId, providerOf, type ProviderId } from "@parcha/agentrun-web";

/** A hold as the server keeps it: always with an end. */
export type WebHold = Hold;
/** How long the server holds a keyless provider whose limit named no end (out of quota for the rest of a run): the
 *  first run after it pays at most one more refusal to learn it again. */
export const ENDLESS_HOLD_MS = 60 * 60_000;
/** The furthest a hold's end may be from `now`: a Retry-After or a reset weeks away holds the host 25 h at most. */
export const MAX_HOLD_MS = 25 * 60 * 60_000;
/** The variable a run's own process gets the server's holds in: JSON, an array of WebHold. */
export const WEB_HOLDS_ENV = "AGENTRUN_SERVE_WEB_HOLDS";

const TOOLS: ReadonlySet<string> = new Set(["search", "fetch", "key"]);
const KINDS: ReadonlySet<string> = new Set(["quota", "rate"]);
const FIELDS = ["provider", "tool", "kind", "until"];
// This process's holds, by provider and tool. Known limit: a runner in its own process (`agentrun-serve runner`) keeps
// its runs' holds here, in its memory: they hold that runner's next runs, and the server's GET /capabilities never sees
// them.
const holds = new Map<string, WebHold>();

/** `value` as a keyless provider's hold, its end `until` (epoch ms; null or Infinity: none named, read as ENDLESS_HOLD_MS
 *  from `now`; at most MAX_HOLD_MS from `now`), or undefined: a keyed or unknown provider, another field, or an end not after `now`. */
function holdOf(value: unknown, now: number): WebHold | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { provider, tool, kind, until } = value as Record<string, unknown>;
  if (Object.keys(value).some((field) => !FIELDS.includes(field))) return undefined;
  if (!isProviderId(provider) || !providerOf(provider).keyless) return undefined;
  if (typeof tool !== "string" || !TOOLS.has(tool) || typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  const named = until === null || until === Number.POSITIVE_INFINITY ? now + ENDLESS_HOLD_MS : typeof until === "number" && Number.isFinite(until) ? until : Number.NaN;
  const end = Math.min(named, now + MAX_HOLD_MS);
  return end > now ? { provider, tool: tool as Hold["tool"], kind: kind as Hold["kind"], until: end } : undefined;
}

/** Keeps `value` (holdOf) as the host's hold on its provider's tool, unless one held already ends no earlier: the hold
 *  kept, or undefined when nothing changed. */
export function noteHold(value: unknown, now: number = Date.now()): WebHold | undefined {
  const hold = holdOf(value, now);
  if (!hold) return undefined;
  const at = `${hold.provider} ${hold.tool}`;
  const held = holds.get(at);
  if (held && held.until >= hold.until && held.until > now) return undefined;
  holds.set(at, hold);
  return hold;
}

/** The holds not yet lifted at `now`. */
export function activeHolds(now: number = Date.now()): WebHold[] {
  return [...holds.values()].filter((hold) => hold.until > now);
}

/** What a server restart does: every hold forgotten. */
export function forgetHolds(): void {
  holds.clear();
}

/** The holds at `now` as a run's spawn environment carries them; none, no variable. */
export function holdsEnv(now: number = Date.now()): Record<string, string> {
  const active = activeHolds(now);
  return active.length ? { [WEB_HOLDS_ENV]: JSON.stringify(active) } : {};
}

/** The holds a run's spawn environment carries (holdsEnv), each read as noteHold reads one; anything else dropped. */
export function holdsFromEnv(env: NodeJS.ProcessEnv, now: number = Date.now()): WebHold[] {
  let given: unknown;
  try {
    given = JSON.parse(env[WEB_HOLDS_ENV] ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(given) ? given.flatMap((one) => holdOf(one, now) ?? []) : [];
}

/** Where a hold a run meets goes: the server's own holds, or, in a run's own process, its channel to the runner. */
let reporter: (hold: Hold) => void = (hold) => void noteHold(hold);
export function reportHoldsTo(report: (hold: Hold) => void): void {
  reporter = report;
}
/** `hold`, a keyless provider's, handed to the server (reportHoldsTo); a keyed one stays the run's. */
export function reportHold(hold: Hold): void {
  if (providerOf(hold.provider).keyless) reporter(hold);
}

/** A held entry as GET /capabilities shows it on a web tool: the hold, its end as a date, and in words. */
export type HeldView = { provider: ProviderId; tool: Hold["tool"]; kind: Hold["kind"]; until: string; words: string };
/** The holds at `now` on `providers`, a web tool's (`tool`), and on their keys. */
export function heldViewOf(tool: "search" | "fetch", providers: ReadonlySet<string>, now: number = Date.now()): HeldView[] {
  return activeHolds(now)
    .filter((hold) => providers.has(hold.provider) && (hold.tool === tool || hold.tool === "key"))
    .map((hold) => ({ provider: hold.provider, tool: hold.tool, kind: hold.kind, until: new Date(hold.until).toISOString(), words: holdingWords(hold) }));
}
