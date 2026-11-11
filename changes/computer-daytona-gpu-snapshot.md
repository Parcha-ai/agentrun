---
packages: @parcha/agentrun-computer
kind: breaking
---
A Daytona GPU computer is made from Daytona's GPU snapshot `daytona-gpu` (`DAYTONA_GPU_SNAPSHOT`), sent as `snapshot` and held in the read-back. Its spec's image is `"daytona-gpu"` or `"default"`. `check()` now refuses a GPU spec that names any other snapshot, a box/Dockerfile one included: give `"default"`.
