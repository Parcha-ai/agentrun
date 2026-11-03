---
packages: repo
kind: feature
---
An agent whose harness the server can't run says why on its page, in place of a run that would fail: "claude-agent doesn't run on this server: claude-agent needs ANTHROPIC_API_KEY.", from capabilities' `harnesses[].reason`, or the harness by name when the server gives no reason. Its Run is off and sends nothing.
