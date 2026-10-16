---
packages: repo
kind: ci
---
**`apps/viewer`: the embed tests can no longer hold a CI job to its limit**
- `test/embed.test.ts` drove Chrome with `spawnSync`, whose timeout sends SIGTERM and then waits for the process to exit,
  with the event loop blocked: a Chrome that did not die on SIGTERM held `npm run test:viewer` until the job's limit, and
  no test timeout could fire. Its Chrome now runs through `test/chrome.ts`: in a process group of its own, killed whole
  with SIGKILL when the test is done with it or a bound passes, with every wait bounded (the launch, each request, each
  page evaluation, the dump) and named when it fails.
- Every embed test has a timeout in seconds, and so do its cleanups. A test's timeout aborts its signal, which kills its
  Chrome at once, and the steered test's one cleanup closes Chrome before it closes the server and removes the files. `test/chrome-bounds.test.ts` shows the bounds on a
  stand-in Chrome that ignores SIGTERM and leaves a helper running.
