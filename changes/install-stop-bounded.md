---
packages: @parcha/agentrun-serve
kind: fix
---
A server that closes while it installs a harness (Claude Code or Codex on first use) no longer waits for npm without a bound. npm gets SIGTERM, then SIGKILL 5 seconds later, and the close goes on once npm has exited. A kill is logged: `event=harness_install_killed` with "npm did not stop within 5 s of SIGTERM; killed". Once npm has started writing, a SIGTERM only marks it: npm finishes the step it is on, which waits for every tarball, before it rolls back. So a slow or stalled registry held Ctrl-C, and any close, until the 10 minute install timeout. npm writes only into the install's staging directory, which is removed, so nothing half installed is left, and the next start installs whole.
