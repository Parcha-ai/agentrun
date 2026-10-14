---
packages: @parcha/pi-durable-disk
kind: feature
---
**pi-durable 1.1**
- The peer ranges of `@earendil-works/pi-durable` and `@earendil-works/chord` widen from `~1.0.4` to `>=1.0.4 <1.2.0`:
  the package installs beside pi-durable 1.1 and still beside 1.0.4. It is developed against 1.1.0, and a CI job
  (`pi-durable-disk-pi-floor`) runs its whole suite again on pi-durable, chord and pi-ai 1.0.4, the lowest the range
  accepts. The conformance minimum follows the installed version (23 cases on 1.0.4, 24 on 1.1), and the scan-order
  control is skipped, with its reason, where the installed `Storage` contract has no order.
- pi-durable 1.1.0 requires a `Storage` to honour `order` on its conversation, entry, task and submission scans and to
  continue a cursor in the order it was returned with. The store's scans are pi's `SqliteStorage` behind the fenced
  database, so they do: pi-durable 1.1.0's storage conformance suite (24 cases, one of them the scans in either order)
  passes on both profiles, and a control shows the runner fails a storage that drops `order`.
- What the package reads of pi's internals is unchanged in 1.1.0: `durable_metadata.next_seq` for the seal, and the
  `retry` and `poll` checkpoints of generation and compaction for parking. Each is read off what the installed pi wrote:
  the seal test commits through pi's storage, a park test waits on a real retry, and a new test waits on a real
  deferred answer (pi's poll phase), so a version that moved either shape fails a test rather than this sentence.
- The Docker runtime image installs pi-durable, pi-ai and chord 1.1.0.
