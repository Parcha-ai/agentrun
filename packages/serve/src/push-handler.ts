// The one handler of every pushed trigger source's requests (trigger-adapter.ts `push`): POST /v2/hooks/{trigger_id},
// for a source whose settings are a trigger's (the webhook), and POST /v2/hooks/{source}, for one whose settings are the
// server's (its event names its trigger). No token: the request's check is its credential, so it is taken in a fixed
// order, the same for every source: its headers, before a byte of the body is read; its body, cut at the source's
// maxBodyBytes (413); its check against its key, or against the kernel's one decoy when there is none, so an unknown
// trigger costs what a known one does; its handshake; its parse; its firing. Every refusal is the one 401, so nothing is
// learned by asking. A request that passes its check and does not parse, or names no trigger of its source, is answered
// 200 and said: the sender is who it says, and sending it again changes nothing.
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./errors.js";
import type { Headers, TriggerAdapter } from "./trigger-adapter.js";
import { ID } from "./validate.js";

/** The kernel's one decoy key: what a request is checked against when it names no trigger, or one with no key. */
const DECOY = `whsec_${randomBytes(32).toString("base64")}`;
/** The one answer to every refused request. */
const REFUSED = "this route needs a request signed by the webhook trigger's secret";

export type PushDeps = {
  adapters: readonly TriggerAdapter[];
  /** Whether `id` is a trigger of the pushed source `kind` that is on. */
  hookable(id: string, kind: string): boolean;
  /** Its firing for the event, recorded (triggers.ts receive). */
  receive(id: string, eventId: string, payload: string): { created: boolean; firing: unknown };
  /** A source's sealed setting (sealed-settings.ts): its key, for a scope. */
  setting(adapterId: string, scope: string, field: string): string | undefined;
  readBody(req: IncomingMessage, max: number): Promise<Buffer>;
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
  // A source's own path (its settings are the server's), else a trigger's (the source whose settings are a trigger's).
  const own = deps.adapters.find((a) => a.id === name && a.push && a.settings?.scope === "server");
  const adapter = own ?? deps.adapters.find((a) => a.push && a.settings?.scope === "trigger");
  const push = adapter?.push;
  if (!adapter || !push) throw refuse("no_hook");
  const now = Date.now();
  const early = push.headers?.(req.headers as Headers, now);
  if (early) throw refuse(early);
  const body = await deps.readBody(req, push.maxBodyBytes);
  const pathTrigger = own ? undefined : ID.test(name) && deps.hookable(name, adapter.id) ? name : undefined;
  const key = own ? deps.setting(adapter.id, "server", push.key) : pathTrigger && deps.setting(adapter.id, pathTrigger, push.key);
  const refusal = push.verify(key ?? DECOY, req.headers as Headers, body, now);
  if (!key || refusal) throw refuse(key ? refusal! : own ? "no_key" : "no_webhook_trigger");
  const handshake = push.handshake?.(req.headers as Headers, body);
  if (handshake) return handshake;
  const event = push.parse(req.headers as Headers, body);
  if (!event) {
    deps.say({ condition: "hook_unparsed", source: adapter.id, route });
    return { status: 200, body: { received: false, reason: "not an event this source takes" } };
  }
  const id = pathTrigger ?? event.triggerId;
  if (!id || !ID.test(id) || !deps.hookable(id, adapter.id)) {
    deps.say({ condition: "hook_no_trigger", source: adapter.id, route, trigger: String(id ?? "") });
    return { status: 200, body: { received: false, reason: "no trigger of this source takes it" } };
  }
  const { created, firing } = deps.receive(id, event.eventId, event.payload);
  return { status: created ? 202 : 200, body: firing, ...(created ? {} : { headers: { "idempotent-replayed": "true" } }) };
}
