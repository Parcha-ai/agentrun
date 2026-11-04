---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A Claude or Codex turn stopped while the session was still recording the person's message stays stopped. Before, the stop found no turn running, so the session read idle, and the stopped message stayed pending and was sent with the next message. Now a turn that ends on its session's stop leaves the session reading `open_turn` while that message is pending, so serve's stop settles it, and it is never sent.
