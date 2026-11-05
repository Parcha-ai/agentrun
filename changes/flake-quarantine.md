---
packages: repo
kind: ci
---
A flaky test can be quarantined: skipped on CI only, under its flake id and owner, for at most 24 hours, with at most three at once (`node scripts/quarantine.mjs --add`, `scripts/quarantine.json`). Once an entry expires, `scripts/quarantine.test.mjs` fails every pull request until the test is fixed and its entry removed. CONTRIBUTING.md says how.
