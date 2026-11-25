---
packages: repo
kind: ci
---
The Postgres store job and the console job, both required, run on Blacksmith in the merge queue and on a pull request from this repository's own branch, as the build and the test shards do. A fork's pull request and main stay on GitHub's runners.
