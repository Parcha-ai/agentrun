---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: breaking
---
A Codex or OpenCode request straight to OpenAI is no longer counted by OpenAI before it is sent: it is held at the kernel's local o200k_base count with its margin, as a request through a gateway already is, so it never waits up to 3 seconds on `POST /v1/responses/input_tokens` first. A capped run on such a route may pause a little sooner than it did on OpenAI's exact count; the cap is still never passed.
- Breaking, for a host of the kernel: `OPENAI_INPUT_COUNTER` is gone. A `ProviderPolicy` that named it as `countInput` drops it and sets `countInputLocally: responsesLocalInputTokens`. Anthropic's count (`countInput` on the claude-agent policy) is unchanged.
