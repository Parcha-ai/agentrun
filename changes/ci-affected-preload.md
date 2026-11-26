---
packages: repo
kind: ci
---
A pull request's affected-test selection (`scripts/test-affected.mjs`) now treats a package test script's preload as part of every test. A change to the file a test script preloads (`--import=<file>`, or the value of any `--flag=<file>`), or to any file that preload reaches by import or by `node:module`'s `register('<relative>', import.meta.url)`, picks every test of that package. Before, such a change picked only the tests that import the file, so a test that only the preload reaches did not run on the pull request and failed first in the merge queue.
