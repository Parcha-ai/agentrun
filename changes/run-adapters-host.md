---
packages: @parcha/agentrun-adapters
kind: feature
---
`@parcha/agentrun-adapters/host`: a session's model proxy, provider-neutral. It listens on the loopback interface and admits only the session's own key (compared in constant time), only the routes a `ProviderPolicy` lists (by exact path text: no absolute URL, `..`, `//`, `%` escape or query), and one strict JSON value with no duplicate key. The policy shapes or refuses the body; the runner's `beforeRequest` is asked before each paid request, and a refusal is answered with a status the client does not retry; the provider's credential is added by the proxy and never reaches the harness; each completed response's usage goes to `afterRequest`, and one cut off before its usage reports nothing. The proxy keeps no ledger: the runner alone accounts model spend.
- `./process` gains `waitForSubmissions` (a harness that keeps running while it waits for input) and `zodShapeFromJsonSchema` (a host tool's JSON Schema as a zod shape, with the zod the harness SDK uses), both copied with their provenance like the rest of the layer.
