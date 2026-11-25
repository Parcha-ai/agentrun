---
packages: @parcha/agentrun-serve
kind: fix
---
A Composio save's account lookup and a run's account check ask Composio for ACTIVE connected accounts alone (`statuses=ACTIVE`). A user's started, expired or turned-off accounts no longer count toward the lookup's 10 pages, so an API-only token's save is no longer refused (`403`) for them, and a run's ACTIVE account behind them is found. On an API-only server, a run's binding (`mcp_auth.<server>.connected_account_id`) names an ACTIVE account of its user: one that is only started, expired or turned off is `422` `not_allowed`, nothing started, and the refusal now reads "Composio lists no such ACTIVE account of that user for the server's toolkit".
