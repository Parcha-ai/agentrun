---
packages: @parcha/agentrun-computer
kind: feature
---
New private package `@parcha/agentrun-computer`, the open platform's computer protocol: a daemon in every computer and one provisioner per vendor. A program runs in a Docker computer through it: `DockerProvider` makes a container with every capability dropped, no new privileges, a pids limit, no network or an open one, and a deadline label, with the daemon `computerd` (a static Go binary, `npm run build:daemon`) mounted read-only as its first process; `connect()` opens the daemon over `docker exec`, and `exec.run` runs argv, never a shell, under a guard process (a child subreaper for that one run) that ends everything the program started, even a setsid or double-forked child, when it ends, times out or is aborted, with stdout and stderr apart and capped.
- A computer runs as a non-root user by default (this process's uid:gid, or 1000:1000 when that is root); root must be asked for in the spec (`user: "0"`), and a provider option of root is refused. `computerd init --deadline` stops the computer at its deadline, and refuses to start without one. With no sizes in the spec a computer gets 2 CPUs, 4 GiB with swap the same, and 1024 pids.
- `check()` refuses in words, before any Docker call, a spec with no image or lifetime, a lifetime over 30 days, a network allowlist, or a field Docker does not support.
- The daemon copies code, with credit in NOTICE and UPSTREAM.json, from E2B envd and Kubernetes sandboxd (both Apache-2.0).
