---
packages: repo
kind: ci
---
The Codex pin check (`verifyCodexBinary`) imports `sha256OfFile` and `checkedOnce` from `@parcha/agentrun-kernel/host`, the code the Claude adapter's check already uses, in place of a line-for-line copy inside the codex package. The copy and the test that held the two copies equal are gone. The check behaves as before. The image check's test now lays the kernel next to the codex adapter in its scratch tree, as npm does, since the adapter depends on it; without it, the test's Codex cases fail on the missing package.
