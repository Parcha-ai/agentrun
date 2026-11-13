---
packages: @parcha/agentrun-serve
kind: feature
---
Composio events start runs through a webhook trigger: `signature: "composio"` checks Composio's delivery (its secret as the whole string, not a decoded `whsec_` key), keys each firing by `webhook-id` and takes `accept` rules by the body's `metadata.trigger_slug` (else its `type`, for Composio's account events such as `composio.connected_account.expired`), with `where` pointers into `/data`. Register the trigger's `hook_url` as Composio's webhook subscription and give Composio's secret with `POST /v2/triggers/{id}/secret` and a `{secret}` body (a composio trigger is made with none, none is made for it, and every request is refused until one is set). The console's trigger page has a Set secret button for it. It is sealed and cut like every trigger secret.
