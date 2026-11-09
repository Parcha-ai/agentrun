---
packages: repo
kind: fix
---
The Render blueprint deploys a 2 GB instance (`1c-2g`) with a 10 GB disk, about $27.50 a month. On a Starter's 512 MB and 1 GB disk, Claude Code's first-use install filled the disk; health turned 503 and Render restarted the service.
