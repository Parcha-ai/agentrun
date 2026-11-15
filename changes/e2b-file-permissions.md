---
packages: @parcha/agentrun-computer
kind: fix
---
Hardening: file permissions on E2B computers. Create now takes write by every user but root off the system paths whose permissions E2B's template build sets wider than root's, before anything else runs in the sandbox, and fails if one is still writable by another user. Root's commands run under `/bin/sh` by its path, with no login shell and `PATH` the system's directories alone.
- The shared machine-host adapter runs this step for any vendor that declares `HostFacts.rootOnly`.
- New Core conformance case `isolation.root-runs`: the computer's user can write nothing root runs (root's `PATH` directories, the daemon, the Archil helper and the directories above them). It checks write access only.
