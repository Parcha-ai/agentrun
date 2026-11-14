---
packages: @parcha/agentrun-computer
kind: feature
---
Agent37: every exec on an instance is a channel on one shared SSH connection, so the daemon's steps, the stdio bridge and the live view's watch no longer each open a WebSocket tunnel and an SSH handshake. A connection carries at most 10 channels at once (OpenSSH's MaxSessions), ends 2 s after its last channel closes, and ends at once when the instance is deleted.
