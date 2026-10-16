---
packages: repo
kind: feature
---
The reference host passes pi-browser's `crossing` option (`RunOptions.crossing`): the kill harness kills at `browser.between-actions` and `browser.action-returned`, and tests that each kill lands, the run resumes to the end and no page action is repeated.
