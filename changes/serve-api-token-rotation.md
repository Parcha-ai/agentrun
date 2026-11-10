---
packages: @parcha/agentrun-serve
kind: feature
---
The server takes a second API token, `AGENTRUN_TOKEN_NEXT`, beside `AGENTRUN_TOKEN` (or `DIR/.token`), so the token rotates with no caller refused: add the next token, move every caller to it, then make it the token and remove the old one. Either token opens every route the token opens (`/v2`, `/mcp`, the store's `/api/*`, the setup code's field); every presented token is compared against both in constant time, with no early return. The next token follows the token's rules (32 characters or more, no whitespace; anything else stops the start), is a secret on the launcher's list, and never reaches a run's process or a runner's loops. `deploy/README.md` gives the three steps.
