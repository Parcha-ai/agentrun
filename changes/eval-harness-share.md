---
packages: @parcha/agentrun-serve
kind: fix
---
A local `eval-template` (no `--server`) installs Claude Code and Codex once, not once per eval. The first local eval that needs one installs its pinned version into `$TMPDIR/agentrun-eval-harnesses/harnesses/<harness>@<version>-<platform>` the way a server's first use does (npm into a fresh directory, checked whole, renamed into place, read-only, one installer at a time across processes), and each eval's scratch data directory gets a link to it instead of a copy. A server's own data directory, its first-use install and its "Installing … (first use)" words are unchanged.
