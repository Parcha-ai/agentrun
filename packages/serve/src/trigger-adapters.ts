// The trigger sources this server has: one line each. Every list of sources (their kinds, what a create checks, a
// firing's `by`, the capabilities, the OpenAPI document's source schemas, the sources a run's message origin may name
// and how its Timeline row labels them) is read from here.
import { registerTriggerSource } from "@parcha/pi-durable-agent/timeline";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { schedule } from "./trigger-schedule.js";
import { slack } from "./trigger-slack.js";
import { webhook } from "./trigger-webhook.js";

export const TRIGGER_ADAPTERS: readonly TriggerAdapter[] = [schedule, webhook, slack];

/** Each of `adapters` a source a run's message origin may name, its Timeline row titled by it. */
export function registerSources(adapters: readonly TriggerAdapter[]): void {
  for (const adapter of adapters) registerTriggerSource(adapter.id, adapter.title);
}
registerSources(TRIGGER_ADAPTERS);
