---
packages: @parcha/pi-durable-disk
kind: fix
---
**`run --app`: the app's factory runs once the claim is held, so `ctx.root` is the live run directory**
- The CLI called the app module's factory before the claim mounted, and a factory that wrote under `ctx.root` (a
  recorder's spool, a `signals/` directory) wrote into the bare mountpoint. The mount hid those writes, and the run later
  failed `ENOENT` on its own files. The claim is now taken first: the mount, the owner lock and `run.json`. Then the
  factory runs, and the Harness opens with what it returns.
- `openDurableRun` gains `afterClaim(claim)`, awaited between the claim and the store with the claim's `ref`, `root`,
  `work` and `store`. Its result (`harness`, `beforeResume`, as `AfterClaim`) goes into the open, so `harness` is now
  optional in the options when `afterClaim` gives it. The open is refused (`INVALID_ARGUMENT`) when neither does. A
  rejection fails the open and lets the claim go. The open step is `after-claim` (`OpenStep`).
- A module that does not load is now found after the claim: it fails the open with `APP_FAILED` (exit 1, as before),
  and the claim is let go. Claim options, if one ever needs them, are static (CLI flags or the environment), never
  returned by the factory.
