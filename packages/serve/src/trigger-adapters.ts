// The trigger sources this server has: one line each. Every list of sources (their kinds, what a create checks, a
// firing's `by`, the capabilities, the OpenAPI document's source schemas) is read from here.
import type { TriggerAdapter } from "./trigger-adapter.js";
import { composio } from "./trigger-composio.js";
import { schedule } from "./trigger-schedule.js";
import { github } from "./trigger-github.js";
import { webhook } from "./trigger-webhook.js";

export const TRIGGER_ADAPTERS: readonly TriggerAdapter[] = [schedule, webhook, github, composio];
