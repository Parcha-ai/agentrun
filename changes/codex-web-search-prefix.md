---
packages: @parcha/agentrun-harness-codex
kind: fix
---
`codexAdapter` refuses a `webSearch` other than `"live"` with a `TypeError` that names the package as its other errors do, `agentrun-harness-codex: webSearch is "live" or absent`; it began `agentrun-codex:`, the package's name before the rename.
