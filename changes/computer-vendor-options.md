---
packages: @parcha/agentrun-computer
kind: fix
---
The hosted computer providers (E2B, Modal, Agent37, Daytona) share their option checks (`requireText`, `httpsUrl`, `hostName`, `sliceProblem`, `loadPackage` in `hosted/options.ts`) instead of each writing its own, with no change to what a computer does. A missing key now reads `options.apiKey, the <vendor> API key is required: …` from the constructor as well as `create()`, and an out-of-range `maxLifetimeMs` is refused in the adapter's words, which the vendor no longer repeats.
