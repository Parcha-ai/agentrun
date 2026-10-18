---
packages: @parcha/pi-durable-disk
kind: docs
---
**The README is the overview, `docs/reference.md` the reference; three new keyless examples**
- The package README is now the overview: what it is (an agent's home and runs live on a disk, so any host can open a run where
  the last one released it), when to use it, a keyless example to run from an npm install, Archil as "bring your own disk",
  what you can do with it, the install lines, and the low-level API (`openDurableRun`, `localRun`, `seed`, `localPlace` and
  `archilPlace`, `PlaceOutcome`, `withClaim`, `recordHome`) with an example or test for each. The reference sections moved,
  with their headings, to `docs/reference.md` (requirements, the quickstarts on a disk, the app, the CLI, host drivers and the
  supervisor, the failure table, security, the layout, the library). `docs/` is not in the published package, so the README's
  links to it resolve on npm's and GitHub's pages, as the links to `examples/` do. Two fixes in the moved text: `readReleased`
  returns `{ bytes, etag }` or null (a snippet bound it to the bytes), and the quickstarts say what the run does (it moves to
  another host from the disk) with the kill as one line.
- New examples, all keyless: `pick-up-a-run` (three processes open one run in turn; the README's first example, which the
  stranger test runs), `seed-a-run` (what `seed` writes, once, and the next open keeps what the run changed) and
  `place-outcome` (`localPlace` reports a run that delivers as `complete` and one that gives up as `failed`, with the models).
  `01-durable-chat/on-a-directory.mjs` stays and is still run in CI.
- The install lines in the README and in `examples/README.md` no longer pin the pi packages to 1.2: the published beta's peers
  are `>=1.0.4 <1.4.0`.
