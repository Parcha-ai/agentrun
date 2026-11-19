---
packages: @parcha/agentrun-harness-acp
kind: breaking
---
The package no longer records a binary's first-seen digest itself: `fileDigestRecord`, `verifyFirstSeen`, the `DigestRecord` type and `ACP_CODES.binaryDrift` (`ACP_BINARY_DRIFT`) are gone. A binary no pin names has its first digest recorded by AgentRun's installer alone (`agentrun harness install`), and a later binary that differs is refused there and at `harness-check` with `HARNESS_BINARY_MISMATCH`. Code that called `verifyFirstSeen` pins the binary's sha256 and calls `verifyPinnedBinary`, or installs it through `agentrun harness install --recipe`.
