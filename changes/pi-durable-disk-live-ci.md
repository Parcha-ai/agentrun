---
packages: @parcha/pi-durable-disk
kind: ci
---
A daily live job, `.github/workflows/pi-durable-disk-live.yml`, runs the package's live suites (claim, env, run, store, supervise, lifecycle, then the Docker driver with parking) against an Archil scratch disk named by the repository secrets `ARCHIL_API_KEY`, `ARCHIL_SCRATCH_DISK` and `ARCHIL_SCRATCH_REGION`. It runs on a schedule or by hand, never for a pull request or in a fork, one run at a time. It refuses to start without the secrets (the suites would otherwise skip and pass), kills a suite that passes its deadline and goes on to the next, removes the run directories and token users a cut suite left, and writes each suite's result and timings to the job summary. Its steps are `test/live/ci.ts`.
