---
packages: @parcha/pi-durable-disk
kind: feature
---
**`beforeResume`: an awaited step before the run resumes**
- `openDurableRun` and an app (`AppOptions`) take an optional `beforeResume(run)`, awaited once per incarnation after the
  Harness is open (its registry installed) and the run is live, and before the Harness resumes. No resumed task takes a
  step until it settles, and what it admits (a submission, a write) is committed before anything a resumed task's steps
  commit. It sees the open Harness, the open's context, the generation, the run record and the claim.
- Use: a host reconciling what a resumed tool depends on (a browser, a mount) before the task that uses it continues;
  `onStep` cannot, since it is synchronous and gets no Harness.
- A rejection fails the open like any open step (`before-resume`), and the claim is released.
- New export: the `BeforeResume` type.
