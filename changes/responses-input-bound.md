---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: fix
---
A capped Codex, OpenCode or pi (on OpenAI's Responses) run's next-step estimate is closer to its real input, so it pauses for a raise later and less often: the input bound counts the text the model reads (a tool's output, a message, a call's arguments) at its own bytes instead of its JSON-escaped ones, some 4 to 6% less on a code-mode body full of fetched pages, which keeps more requests under the 272k-token long-context tier where every rate doubles. On a route straight to OpenAI the input is counted exactly by OpenAI's `POST /v1/responses/input_tokens`, asked with only the credential and account headers and never through a gateway; a count that fails or takes over 3 seconds leaves the byte bound. The cap still never spends past itself: tool definitions and encrypted reasoning keep every byte.
