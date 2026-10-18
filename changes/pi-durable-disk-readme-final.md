---
packages: @parcha/pi-durable-disk
kind: docs
---
**The README leads with what the package is, a keyless example and the low-level API; a new example, `pick-up-a-run`**
- The package README now opens with what it is (an agent's home and runs live on a disk, so any host can open a run where
  the last one released it), when to use it, a keyless example to run from an npm install, Archil as "bring your own disk",
  what you can do with it, the install lines, and the low-level API (`openDurableRun`, `localRun`, `archilPlace`/`localPlace`,
  `withClaim`, `seed`, `recordHome`, `PlaceOutcome`) with a link to an example or test for each. The reference sections
  follow, unchanged but for two fixes: `readReleased` returns `{ bytes, etag }` or null (the snippet bound it to the bytes),
  and the Linux-host quickstart heading no longer pitches a kill.
- New example `examples/pick-up-a-run/` is the README's first example: three processes open one run in turn, each answers a
  question of the same chat and releases it, the last still knows the first question, and `readLocalRunStatus` reads the
  record from outside. It replaces `01-durable-chat/on-a-directory.mjs` as what the README and the stranger test run; that
  example stays and is still run in CI.
- The install lines no longer pin the pi packages to 1.2: the published beta's peers are `>=1.0.4 <1.4.0`.
