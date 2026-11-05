---
packages: @parcha/agentrun-serve
kind: fix
---
The parts of every workflow run's graph that serve keeps redacted, and each run's last whole graph kept for a busy store's read, share one cache bounded at 32 MB, which evicts the least recently used entries one at a time. It used to keep up to 2048 parts per run with no bound across runs, and dropped them all at once past that.
