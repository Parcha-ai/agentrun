---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A turn that a halt ended with a reason now ends `failed`, naming it, never `interrupted` with the reason dropped: a harness's spend cap, its transcript mirror, a refused spawn. Only the session's own stop (its interrupt or its close, told apart by identity with the kernel's `SessionHalt`) and its host's stop end a turn `interrupted`. `abortedOutcome` decides it, and both adapters use it. This changes how spend-cap and mirror halts end a turn: a host that read `interrupted` for them now reads `failed` with the reason.
