---
packages: @parcha/pi-durable-disk
kind: feature
---
**`beforeResume`: an awaited step before the run resumes**
- `openDurableRun` and an app (`AppOptions`) take an optional `beforeResume(run)`, awaited once per incarnation after the
  Harness is open (its registry installed) and the run is live, and before the Harness resumes. No resumed task takes a
  step until it settles, and what it admits (a submission, a write) is committed before anything a resumed task's steps
  commit. It sees the open Harness, the open's context, the generation, the run record and the claim.
- It also gets the store the Harness was opened over, read-only, and its head: `storage` has `scanConversations`,
  `scanTasks`, `scanDocuments` and `document` on a frozen object of its own, with no `commit` or `mintId` even through a
  cast, and `head` is the store's last committed sequence once the Harness is open. A recorder snapshots every document
  at `head` in the hook; until the hook commits, the current state is the state at `head`, which is how a document that
  keeps no history (`latest`, session and task documents) reads.
- Use: a host reconciling what a resumed tool depends on (a browser, a mount) before the task that uses it continues;
  `onStep` cannot, since it is synchronous and gets no Harness.
- A rejection fails the open like any open step (`before-resume`), and the claim is released.
- New exports: the `BeforeResume` and `StoreReads` types.
