---
packages: @parcha/agentrun-computer
kind: feature
---
The conformance CLI measures whether a computer provider works and how fast: `--tti <n>` makes `n` computers one at a time and `--burst <n>` makes `n` at once, each timed from its create call to its first command's answer through this package's provider layer, then deleted. It prints whether the provider came up, the median, p95 and p99, the success rate and ComputeSDK's sandbox score for each shape, and a cleanup line that shows nothing was left; it exits 0 only when every computer came up. `measureTti`, `formatTti`, `ttiStats` and `ttiScore` do the same from code.
