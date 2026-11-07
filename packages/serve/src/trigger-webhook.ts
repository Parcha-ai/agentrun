// The signed webhook: a trigger source pushed to the server. A POST to /v2/hooks/{trigger_id}, signed under the
// trigger's own secret (Standard Webhooks), is a firing, keyed by its `webhook-id` (server.ts checks it).
import { closedSchema, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";

export const webhook: TriggerAdapter = {
  id: "webhook",
  label: "webhook trigger",
  delivery: "push",
  owner: false,
  settings: { scope: "trigger", fields: { secret: { mint: true } } },
  describe: '{kind: "webhook"}',
  fires: "a signed request to /hooks/{trigger_id} (`webhook`)",
  firedBy: "`webhook`: a signed request to /hooks/{trigger_id}, its key from the trigger and the request's `webhook-id`.",
  schemas: [closedSchema({ kind: { const: "webhook" } })],
  parse(value, _now, _bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind"]));
    return { kind: "webhook" };
  },
  wellFormed: () => true,
};
