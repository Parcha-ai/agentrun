---
packages: @parcha/agentrun-adapters, @parcha/agentrun-claude-agent, @parcha/agentrun-codex
kind: fix
---
The model proxy now tells the host, before a paid request is sent, the most input tokens it can be billed for. A spend cap could only count a request's cost once it was billed, so a single request whose input alone was over what was left of the cap was still sent and paid. `beforeRequest` now carries `inputTokensMax`: the UTF-8 bytes of the body exactly as it is sent, plus the input the provider adds that the body does not carry. A byte-level BPE token covers at least one byte, so this never undercounts the body, however dense its text. Each `inFlight` entry carries its own `inputTokensMax` until that request answers, so a cap can hold every open request at its own bound. When the provider's addition cannot be read, `inputTokensMax` is undefined, never 0, and a cap treats that input as unknown.
- A provider policy can say what its provider adds with `serverInputOverhead(body)`. The Claude policy adds the tool-use system prompt the Messages API bills for a body with tools: 675 tokens for tool_choice auto or none and 804 for any or tool, the largest documented figures for any current model. The Codex policy adds none.
- `inputTokensMaxOf(policy, body, sent)` is exported from `@parcha/agentrun-adapters/host`.
- The proxy serializes the body once before admission and sends exactly what it measured. A body that cannot be serialized is refused before the runner is asked, so it is never booked.
