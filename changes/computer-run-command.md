---
packages: @parcha/agentrun-computer
kind: feature
---
New private package `@parcha/agentrun-computer`, the open platform's computer protocol: a daemon in every computer and one provisioner per vendor. A program runs in a Docker computer through it: `DockerProvider` makes a container with every capability dropped, no new privileges, a pids limit, no network or an open one, and a deadline label, with the daemon `computerd` (a static Go binary, `npm run build:daemon`) mounted read-only as its first process; `connect()` opens the daemon over `docker exec`, and `exec.run` runs argv, never a shell, in its own process group, killed whole on timeout or abort, with stdout and stderr apart and capped.
- `check()` refuses in words, before any Docker call, a spec with no image or lifetime, a network allowlist, or a field Docker does not support.
- The daemon copies code, with credit in NOTICE and UPSTREAM.json, from E2B envd and Kubernetes sandboxd (both Apache-2.0).
