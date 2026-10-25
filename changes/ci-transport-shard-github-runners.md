---
packages: repo
kind: ci
---
The merge queue runs the transport test shard on GitHub's runners, as it does the viewer shard. Blacksmith's kernels have no Yama ptrace_scope, and pi-transport's launcher refuses a launch with stdin or secrets on such a host, so the shard's launch tests failed there while the code was right.
