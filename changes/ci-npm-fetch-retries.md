---
packages: repo
kind: ci
---
**A registry connection that fails during `npm ci` no longer fails a CI job at once**
- A registry request that fails before its response arrives (a connection reset, refused or timed out, or a 5xx) is retried 5 times, 20 seconds and then 2 minutes apart, where npm's default gave up after 2 retries in about 70 seconds. This holds for every `npm` and `npx` in the package checks, including the ones a script runs inside a job, except the stranger and source-consumer checks, which start npm with a clean environment on purpose.
- npm never retries a download that drops midway. Each `npm ci` step in the package checks runs once more 15 seconds after a failure, with a warning in the log, and `scripts/build-console.mjs` runs the console's `npm ci` once more after a failure, printing one warning line. A second failure fails the job as before.
- What it buys: a short registry outage costs a job up to about 8 minutes, or one extra install, instead of failing it and sending a merge-queue entry back to the end of the queue. The risk: a real outage, or a lockfile npm refuses, fails a job up to a few minutes later than it did.
