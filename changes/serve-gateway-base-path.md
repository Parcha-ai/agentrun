---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENT_MODEL_BASE_URL` (codex) and `ANTHROPIC_BASE_URL` (claude-agent) now take a gateway under a path, so one OpenRouter key can serve every harness: `https://openrouter.ai/api` for claude-agent, and `https://openrouter.ai/api/v1` or `https://openrouter.ai/api` for codex and pi. codex sends to `<base>/v1/responses` and claude-agent to `<base>/v1/messages`, with a trailing `/v1` on the base taken once. A base that could send a key elsewhere than it reads is refused before any request, naming its setting: one with userinfo, a query or fragment, a `.` or `..` path segment (raw or encoded), whitespace, or plain http to anything but this machine.
