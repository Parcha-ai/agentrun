---
packages: @parcha/agentrun-computer
kind: breaking
---
The hosted computer providers (E2B, Modal, Agent37, Daytona) share their option checks and timeouts through the adapter, with no change to what a computer does. Breaking, for code that writes its own `MachineHost` or calls `hostedProvider`: `HostedOptions` takes the vendor's `descriptor` (its `network` forms and `mounts` kinds, which `capabilities()` now reads from it) and `HostFacts` no longer has `network` or `mounts`; `HostFacts.timeouts` is the vendor's default bounds, which the adapter merges under the caller's and writes back for the host to read at call time (`timeoutOf` in `hosted/options.ts`). A key that is missing now reads `options.apiKey, the <vendor> API key is required: …` from the constructor as well as `create()`, an out-of-range `maxLifetimeMs` is refused in the adapter's words, and the shared checks (`requireText`, `httpsUrl`, `hostName`, `sliceProblem`, `loadPackage`) are one copy.
