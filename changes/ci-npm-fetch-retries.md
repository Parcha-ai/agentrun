---
packages: repo
kind: ci
---
Every `npm` and `npx` in the package checks, including the ones a script runs inside a job (except the stranger and source-consumer checks, which start npm with a clean environment on purpose), now retries a registry request that fails before its response arrives (a connection reset, refused or timed out, or a 5xx) 5 times, waiting 20 seconds and then 2 minutes between tries, where npm's default gave up after 2 retries in about 70 seconds. A short registry outage costs a job up to about 8 minutes instead of failing it and sending a merge-queue entry back to the end of the queue. A connection that drops in the middle of a download is not retried by npm and still fails the job.
