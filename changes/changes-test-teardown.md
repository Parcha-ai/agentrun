---
packages: repo
kind: fix
---
The scripts tests that commit in a temporary repository (changes, release-preflight, ci-build-output, test-workspaces, test-affected) run git with `gc.auto=0` and `maintenance.auto=false`, and remove the repository with retries. A commit's detached background maintenance could write in `.git` while the test removed it, failing the teardown with ENOTEMPTY, which once dropped a merge queue run.
