---
packages: repo
kind: ci
---
The runner expression that puts the build, the test shards, the Postgres store job and the console job on Blacksmith for the merge queue and this repository's own pull requests is written once, as a YAML anchor on the build job, and the other four use it by alias. No runner changes.
