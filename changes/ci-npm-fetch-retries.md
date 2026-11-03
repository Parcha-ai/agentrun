---
packages: repo
kind: ci
---
**A registry connection that fails during `npm ci` no longer fails a CI job at once**
- A registry request that fails before its response arrives (a connection reset, refused or timed out, or a 5xx) is retried 5 times, 20 seconds and then 2 minutes apart, where npm's default gave up after 2 retries in about 70 seconds. This holds for every `npm` and `npx` in the package checks, including the ones a script runs inside a job, except the stranger and source-consumer checks, which start npm with a clean environment on purpose.
- npm never retries a download that drops midway. `node scripts/npm-ci-retry.mjs <flags>` runs `npm ci <flags>` and retries once on a network error only: when npm's error code is ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN, ENOTFOUND, EPIPE or ERR_SOCKET_TIMEOUT, or it reports a network error, it prints a `::warning::` naming the code, waits 15 seconds (`NPM_CI_RETRY_WAIT_MS`) and runs once more. Any other failure, a lockfile out of step with `package.json` or an engine npm refuses, and a second failure exit at once with npm's own code. Every `npm ci` step in the package checks runs through it, and so does the console's `npm ci` in `scripts/build-console.mjs`.
- What it buys: a short registry outage costs a job up to about 8 minutes, or one extra install, instead of failing it and sending a merge-queue entry back to the end of the queue. The risk: a real registry outage fails a job a few minutes later than it did.
