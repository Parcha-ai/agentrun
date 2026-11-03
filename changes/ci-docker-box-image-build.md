---
packages: repo
kind: ci
---
CI's advisory real-Docker job now also builds serve's default box image (python 3.12, git and curl, from its recipe) on the runner's Docker, checks its label, and runs `python3`, `git` and `curl` in a box made from it, which has no network. The step's per-file bound goes from 300 s to 900 s, inside the job's 30 minutes, for the build. It stays advisory: a failure shows and blocks nothing.
