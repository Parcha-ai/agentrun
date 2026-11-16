---
packages: @parcha/agentrun-serve
kind: feature
---

Inspect an agent's configuration beside its runs and versions, query filtered runs through the shared coding-agent action, and see Mission Control activity and analytics without a model-key gate. Refresh external work when returning to the console. Preserve archived-run scope in coding-agent queries, and keep focused daily analytics readable inside narrow cards. Let slow Mission Control reads finish before automatic refresh, while preserving explicit refresh and scope changes. Keep the server's save warnings visible beside the inspected configuration.

Keep a visible Detailed editor action for managed agents, including archived agents, so the existing revision history and Make current controls remain reachable. Native and SDK agents retain their original-source editing handoffs; inspecting Versions remains read-only.

Disable Load more while the agent's run history or refresh metadata is still being read, then allow pagination again after the refresh settles. Preserve loaded rows and the existing retry guidance when a refresh fails.

Keep the last successfully loaded Mission Control counts, analytics and run links visible beside a refresh error. Preserve the initial error state when no data has loaded, and let retry replace the saved view after a successful read.
