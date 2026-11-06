---
packages: @parcha/agentrun-computer
kind: fix
---
Six fixes from a security read of the Docker provider and the conformance suite, before a vendor runs it.
- Core's `provider.network-change` asks only for networks the provider does not declare and expects each refused, so a provider that can switch networks never puts a Core computer on a wider one. The applied change moves to a new Full case, `provider.network-switch` (`network:open`), on a computer of its own.
- `--provider docker` bounds its `docker version` call (30 s, then killed): a hung docker CLI fails the run in words instead of hanging it.
- Every create a case starts goes through the runner (`t.attempt(spec, by?)`), so a computer from `provider.check-refuses` or `drift.version` that arrives after its case ended is deleted, and named in `cleanup.late`, before the report returns.
- `--only` that leaves Core cases out reports `core: "partial"` with `coreNotRun`, prints `core PARTIAL` and never PASS, and exits 3 when every case that ran passed. A script that checks for exit 0 no longer takes a subset for a Core pass.
- The daemon's 256 MiB retained-output budget now covers running processes' rings: once no ended ring is left to let go, each live ring is limited to an equal share (at least 64 KiB) and drops its oldest bytes, which reads report in `dropped`.
- `attach` returns the computer's ref with `spec`, read back from the computer: `image`, `user` (`uid:gid`, `"0:0"` for root), `network`, sizes, `workdir` and `deadline`. Code that compared an attach result to a ref with deep equality compares `id` and `name` instead.
