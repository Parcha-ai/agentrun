---
packages: @parcha/agentrun-serve
kind: ci
---
The runner claim tests wait for the runner's own `claimed` event before they move the clock or close a runner, not for the store's claim call to return. On Postgres the runner reads the claim's command rows in one more round trip before it holds the claim, so the first case moved its mocked clock with nothing to renew and hit its 60 s timeout, and the close case closed before the loop existed. Both cases now gate that read until both runners' claims are back, so the same order happens on SQLite every time.
