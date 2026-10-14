---
packages: @parcha/pi-durable-disk
kind: docs
---
**An example, `audit-across-crashes`: the store is the record**
- A run on a local directory is killed twice in the middle of a tool call. A recorder in `beforeResume` snapshots every
  task, document and transcript entry at each incarnation's `head`, and the example prints a per-generation account (who
  asked what, who answered, which calls were cut and which generation settled them as `interrupted`) read from those
  snapshots alone. No disk, no key: `node examples/audit-across-crashes/main.ts` after the build, with pi-ai's faux model.
  A test runs it in `npm test`.
