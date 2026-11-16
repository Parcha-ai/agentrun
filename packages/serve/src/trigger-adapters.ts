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

/** `value` with each trigger source in it (an object whose `kind` is a source's with a `shown`) as an answer sends it:
 *  for an answer kept before that rule (an Idempotency-Key's record), so its replay is what a read answers now. */
export function shownSources(value: unknown, adapters: readonly TriggerAdapter[] = TRIGGER_ADAPTERS): unknown {
  if (Array.isArray(value)) return value.map((item) => shownSources(item, adapters));
  if (value === null || typeof value !== "object") return value;
  const walked = Object.fromEntries(Object.entries(value).map(([field, item]) => [field, shownSources(item, adapters)]));
  const kind = (value as { kind?: unknown }).kind;
  const adapter = typeof kind === "string" ? adapters.find((a) => a.id === kind) : undefined;
  return adapter?.shown ? adapter.shown(walked as Source) : walked;
}
