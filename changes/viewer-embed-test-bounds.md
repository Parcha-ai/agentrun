---
packages: repo
kind: ci
---
**`apps/viewer`: the embed tests can no longer hold a CI job to its limit**
- `test/embed.test.ts` read its pages with `--dump-dom` and `--virtual-time-budget`, which now and then never finishes,
  through `spawnSync`, whose timeout sends SIGTERM and then waits for the process to exit with the event loop blocked: a
  Chrome that did not die held `npm run test:viewer` until the job's limit, and no test timeout could fire. Every embed
  test now drives Chrome over the DevTools protocol in real time, through `test/chrome.ts`: Chrome in a process group of
  its own, killed whole with SIGKILL when the test is done with it, a bound passes or the test's signal aborts; every
  wait bounded and named (the launch, each request, each page evaluation, a page drawing), and an answer that can no
  longer come (the socket closed, Chrome exited) failing at once.
- Every embed test has a timeout in seconds, and so do its cleanups, which close every Chrome before removing its files.
  `test/chrome-bounds.test.ts` shows the bounds on a stand-in Chrome that ignores SIGTERM and leaves a helper running.
