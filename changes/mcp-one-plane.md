---
packages: @parcha/agentrun-serve
kind: feature
---
A saved MCP server's read says why a tool can't be granted, and a failed MCP save says it in the one credential word.
- Each tool of GET /v2/settings/mcp-servers/{name} (and the save's answer) may carry `grant_problems`: why a grant of it is refused where it would run, in the words the save's 422 says. `*` is a refusal on every harness (its wire name `mcp__<server>__<tool>` is past the 52 characters every harness's tool names share); a harness id is that harness alone, whose own MCP client would drop or retype the tool's schema (claude-agent drops a tool whose schema's root has `anyOf`, `allOf` or `oneOf`). The console renders these words and keeps no rule of its own; it also disables a known meta tool (`grantable: false`) in the picker, with the server's reason.
- A preview, save or refresh that fails now cuts every credential value and its bare token, of any header scheme (`Basic`, `Token`, `Bearer`), from the server's words, as a run's call already did; before, only a `Bearer` token was cut, and any other scheme's bare token a server echoed was shown. The cut text reads `[redacted]`, where the preview used to say `[credential]`.
- One credential scrubber, one 4 MiB cap on an upstream answer and one SDK client setup now serve the probe and the run's gateway (packages/serve/src/mcp-wire.ts); every MCP read of the registry from the runner and the server goes through the sealed layer (mcp-store.ts).
