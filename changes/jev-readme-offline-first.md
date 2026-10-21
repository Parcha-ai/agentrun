---
packages: @parcha/agentrun-jev
kind: docs
---
The README now starts with the offline sample, which needs no key, then the live call. It says that a missing key fails at `createJevRunner`, before any request, that the TypeScript samples need a TypeScript runner, and it lists the whole public API. It also describes the `Retry-After` wait and the 429 give-up, the `requestDiagnostic` on a refused request, and that `cost_usd` is the reported `usage.cost` first.
