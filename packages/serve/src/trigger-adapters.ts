// The trigger sources this server has: one line each. Every list of sources (their kinds, what a create checks, a
// firing's `by`, the capabilities, the OpenAPI document's source schemas) is read from here.
import type { Source, TriggerAdapter } from "./trigger-adapter.js";
import { composio } from "./trigger-composio.js";
import { schedule } from "./trigger-schedule.js";
import { github } from "./trigger-github.js";
import { webhook } from "./trigger-webhook.js";
import { email } from "./trigger-email.js";
import { feed } from "./trigger-feed.js";

export const TRIGGER_ADAPTERS: readonly TriggerAdapter[] = [schedule, webhook, github, composio, email, feed];

/** A trigger's answer (an object whose top-level `source` is a trigger source) with that source as a read sends it now
 *  (its adapter's `shown`): for an answer kept before that rule, an Idempotency-Key's record of a trigger create. Only
 *  that one field of that one shape: any other value is as it is. */
export function shownTrigger(body: unknown, adapters: readonly TriggerAdapter[] = TRIGGER_ADAPTERS): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const source = (body as { source?: unknown }).source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return body;
  const kind = (source as { kind?: unknown }).kind;
  const adapter = typeof kind === "string" ? adapters.find((a) => a.id === kind) : undefined;
  return adapter?.shown ? { ...body, source: adapter.shown(source as Source) } : body;
}
