---
packages: @parcha/agentrun-serve
kind: breaking
---
`startServe`'s `ServeOptions` drops nine fields the server never read: `settleRetryMs`, `carryBackRetry`, `readyTimeoutMs`, `openTimeoutMs`, `fauxHandedNonce`, `beforeRaiseLaunch`, `onPauseCheck`, `beforeSubmit` and `beforeMetaSave`. They belonged to the per-run process the server no longer starts, and setting one had no effect. An embedder that passes one in TypeScript removes it; nothing else changes.
