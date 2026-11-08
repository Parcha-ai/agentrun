// The one handler of every pushed trigger source's requests (trigger-adapter.ts `push`): POST /v2/hooks/{trigger_id},
// for a source whose settings are a trigger's (the webhook), and POST /v2/hooks/{source}, for one whose settings are the
// server's (its event names its trigger). No token: the request's check is its credential, so it is taken in a fixed
// order, the same for every source: its headers, before a byte of the body is read; its body, cut at the source's
// maxBodyBytes (413); its check against its key, or against the kernel's one decoy when there is none, so an unknown
// trigger costs what a known one does; its handshake; its parse; its firing. Every refusal is the one 401, so nothing is
// learned by asking. A request that passes its check and does not parse, names no trigger of its source, or is an event
// its trigger does not take (`{ok: "ignored"}`), is answered 200 and said: the sender is who it says, and sending it
// again changes nothing.
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./errors.js";
import type { Headers, PushContext, Source, TriggerAdapter } from "./trigger-adapter.js";
import { ID } from "./validate.js";

/** The kernel's one decoy key: what a request is checked against when it names no trigger, or one with no key. */
const DECOY = `whsec_${randomBytes(32).toString("base64")}`;
/** How long a hook request's body has to arrive, whole: no token guards this route, so a sender that dribbles its body
 *  never holds a socket for the server's own, longer request timeout (kept for uploads). */
export const HOOK_BODY_MS = 30_000;

/** A refusal whose request is cut, not read: answered, then its socket closed (server.ts). */
export class HookCut extends ApiError {}

/** The body of `req`, at most `max` bytes, within HOOK_BODY_MS. Past the cap (as declared up front, or as counted while
 *  it streams) it is 413 at once, and past the time 408: nothing more is read, and the socket is closed after the
 *  answer, never drained. */
export function readCapped(req: IncomingMessage, max: number, ms = HOOK_BODY_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cut = (error: HookCut) => {
      clearTimeout(timer);
      req.off("data", onData).off("end", onEnd).off("error", onError);
      req.pause();
      reject(error);
    };
    const tooLarge = () => cut(new HookCut("payload_too_large", `the body is over ${max} bytes`, { details: { limit: "max_body_bytes" } }, { connection: "close" }));
    const declared = Number(req.headers["content-length"]);
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) return tooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => (clearTimeout(timer), resolve(Buffer.concat(chunks)));
    const onError = (error: Error) => (clearTimeout(timer), reject(error));
    const timer = setTimeout(() => cut(new HookCut("request_timeout", `the body did not arrive within ${ms / 1000} s`, {}, { connection: "close" })), ms);
    if (Number.isFinite(declared) && declared > max) return tooLarge();
    req.on("data", onData).on("end", onEnd).on("error", onError);
  });
}

/** The one answer to every refused request. */
const REFUSED = "this route needs a request signed by the webhook trigger's secret";

export type PushDeps = {
  adapters: readonly TriggerAdapter[];
  /** The source of trigger `id`, when it is a trigger of a pushed source that is on. */
  hooked(id: string): Source | undefined;
  /** How long a hook's body has to arrive, whole (default HOOK_BODY_MS): a test's seam. */
  bodyMs?: number;
  /** A request trigger `id` ignored, under the key its event would have (triggers.ts ignored): kept for its day. */
  ignored?(id: string, eventId: string): void;
  /** Its firing for the event, recorded (triggers.ts receive), with what the source says of it (`attrs`). */
  receive(id: string, eventId: string, payload: string, attrs?: Record<string, string>): { created: boolean; firing: unknown };
  /** The triggers of the pushed source `kind`, on, that listen on `scope` (its adapter's scopeOf). */
  scoped(kind: string, scope: string): string[];
  /** The triggers of the pushed source `kind` that are on, with their sources: the ones its adapter's takes reads. */
  listening?(kind: string): { id: string; source: Source }[];
  /** A source's sealed setting written (sealed-settings.ts), for a scope: a handshake's (PushContext.set). */
  setSetting?(adapterId: string, scope: string, field: string, value: string): void;
  /** Every trigger of the pushed source `kind` that is on, turned off with why (triggers.ts turnOff); how many. */
  turnOff?(kind: string, detail: string): number;
  /** A source's sealed setting (sealed-settings.ts): its key, for a scope. */
  setting(adapterId: string, scope: string, field: string): string | undefined;
  /** A refusal, said: its route and why. */
  refused(route: string, reason: string): void;
  say(fields: Record<string, string>): void;
};
export type PushAnswer = { status: number; body: unknown; headers?: Record<string, string> };

/** The request to /v2/hooks/{segment}: its answer, or the one 401 (thrown). */
export async function receivePush(deps: PushDeps, req: IncomingMessage, segment: string): Promise<PushAnswer> {
  const route = `/v2/hooks/${segment}`;
  const refuse = (reason: string) => (deps.refused(route, reason), new ApiError("unauthenticated", REFUSED));
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    throw refuse("malformed_path");
  }
  // A source's own path (its settings are the server's), else a trigger's, checked by that trigger's own source (its
  // settings are a trigger's). A path that names no such trigger is checked as the first such source's, against the
  // decoy: the same work and the same 401, so no id is learned by asking.
  const own = deps.adapters.find((a) => a.id === name && a.push && a.settings?.scope === "server");
  const named = own || !ID.test(name) ? undefined : deps.hooked(name);
  const trigger = named && deps.adapters.find((a) => a.id === named.kind && a.push && a.settings?.scope === "trigger");
  const adapter = own ?? trigger ?? deps.adapters.find((a) => a.push && a.settings?.scope === "trigger");
  const push = adapter?.push;
  if (!adapter || !push) throw refuse("no_hook");
  const now = Date.now();
  const early = push.headers?.(req.headers as Headers, now);
  if (early) throw refuse(early);
  const body = await readCapped(req, push.maxBodyBytes, deps.bodyMs);
  const source = trigger ? named : undefined;
  const pathTrigger = source ? name : undefined;
  const key = own ? deps.setting(adapter.id, "server", push.key) : pathTrigger && deps.setting(adapter.id, pathTrigger, push.key);
  // Checked against the clock now the body has arrived: a timestamp at the tolerance's edge never passes by a slow body.
  const refusal = push.verify(key ?? DECOY, req.headers as Headers, body, Date.now(), key ? source : undefined);
  if (!key || refusal) throw refuse(key ? refusal! : own ? "no_key" : "no_webhook_trigger");
  const scope = own ? "server" : pathTrigger!;
  const ctx: PushContext = {
    setting: (field) => deps.setting(adapter.id, scope, field),
    set: (field, value) => deps.setSetting?.(adapter.id, scope, field, value),
    turnOff: (detail) => deps.turnOff?.(adapter.id, detail) ?? 0,
    say: deps.say,
  };
  const handshake = push.handshake?.(req.headers as Headers, body, ctx);
  if (handshake) return handshake;
  const events = push.parse(req.headers as Headers, body, source);
  // Verified, and not an event its trigger takes: answered, so the sender does not send it again, and said once.
  if (!Array.isArray(events)) {
    deps.say({ condition: "hook_ignored", source: adapter.id, route, ...(pathTrigger ? { trigger: pathTrigger } : {}), reason: events.ignored, ...(events.event ? { event: events.event } : {}) });
    if (pathTrigger && events.key !== undefined) deps.ignored?.(pathTrigger, events.key);
    return { status: 200, body: { ok: "ignored" } };
  }
  if (!events.length) {
    deps.say({ condition: "hook_unparsed", source: adapter.id, route });
    return { status: 200, body: { firings: [] } };
  }
  // A trigger's own path: each event is its own firing. One (a webhook's request) is answered as its firing; more, as a
  // server-wide source's are, by the firings they made.
  if (pathTrigger) {
    const fired = events.map((event) => deps.receive(pathTrigger, event.key, event.text, event.attrs));
    if (fired.length > 1) return { status: fired.some((f) => f.created) ? 202 : 200, body: { firings: fired.map((f) => f.firing) } };
    const { created, firing } = fired[0]!;
    return { status: created ? 202 : 200, body: firing, ...(created ? {} : { headers: { "idempotent-replayed": "true" } }) };
  }
  // A server-wide source whose triggers choose their own events: each event fires every trigger that takes it, each its
  // own firing under its own key; every other trigger keeps the event's key for its day (as an ignored request's), so
  // the same request relabeled is a duplicate there too. One no trigger takes is answered ignored, and said. A trigger
  // holding too many firings due is passed over, and said, and the rest still fire.
  if (adapter.takes) {
    const fired: { created: boolean; firing: unknown }[] = [];
    let refused: unknown;
    let taken = false;
    for (const event of events) {
      for (const { id, source } of deps.listening?.(adapter.id) ?? []) {
        if (adapter.takes(source, event) !== undefined) {
          deps.ignored?.(id, event.key);
          continue;
        }
        taken = true;
        try {
          fired.push(deps.receive(id, event.key, event.text, event.attrs));
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "rate_limited") throw error;
          refused = error;
        }
      }
    }
    if (!taken) {
      deps.say({ condition: "hook_ignored", source: adapter.id, route, reason: "no_trigger_takes_it", ...(events[0]?.event ? { event: events[0].event } : {}) });
      return { status: 200, body: { ok: "ignored" } };
    }
    if (!fired.length && refused) throw refused;
    return { status: fired.some((f) => f.created) ? 202 : 200, body: { firings: fired.map((f) => f.firing) } };
  }
  // A server-wide source's: each event fires the one trigger that listens on its scope (a scope belongs to one trigger:
  // triggers.ts scope_taken). One no trigger takes is said; one more than one does (a file edited by hand) fires none,
  // and is said with their ids, so no event fires twice or reaches whichever came first.
  const fired: { created: boolean; firing: unknown }[] = [];
  for (const event of events) {
    const ids = event.scope === undefined ? [] : deps.scoped(adapter.id, event.scope);
    if (ids.length === 1) fired.push(deps.receive(ids[0]!, event.key, event.text, event.attrs));
    else if (!ids.length) deps.say({ condition: "hook_no_trigger", source: adapter.id, route, scope: String(event.scope ?? "") });
    else deps.say({ condition: "hook_scope_ambiguous", source: adapter.id, route, scope: String(event.scope), triggers: ids.join(",") });
  }
  return { status: fired.some((f) => f.created) ? 202 : 200, body: { firings: fired.map((f) => f.firing) } };
}
