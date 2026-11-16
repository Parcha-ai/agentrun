---
packages: @parcha/agentrun-computer
kind: feature
---
A vendor whose process output comes as server-sent events reaches `framedExec` with no reader of its own: `sse` in `hosted/rest.ts` reads a `text/event-stream` body as the HTML standard says, beside `ndjson`, which moves there from `hosted/framed-exec.ts`. PROVIDERS.md's worked example is Hyperbrowser's process API (base64 output events, its `system` lines dropped), and the exec pre-check passes over a fake of it in the tests.
