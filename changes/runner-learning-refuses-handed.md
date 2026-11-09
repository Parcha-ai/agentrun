---
packages: @parcha/agentrun-serve
kind: fix
---
The runner's learning end never learns what a run was handed. Its checks used to refuse only the runner's own secrets. They now also refuse the keys the run's claim handed it and the sign-in pointers its row says it was handed, read back from the store's sign-ins (the server's `refused(run)` rule). A proposal that holds one is refused whole. Every string the end keeps in `learning_proposals` (the turn as it answered, what the person said, the proposal's words) is cut of the same list. A run whose handed pointers can't be read back learns nothing. Its learning is dropped as `propose_failed`, saying the sign-in could not be read back, and no learning run is queued. `handedValuesOf` (`handed-values.ts`) is the one read of a run's handed pointers, shared by the store-backed run view and the learning end. `signInReads` (`sign-ins-store.ts`) gives the read half of the store's sign-ins.

Upgrading: nothing to do.
