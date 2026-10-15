---
packages: repo
kind: feature
---
The reference entry fetches a demo's `sources.json` (checked files `{ id, url, bytes, sha256, license }`) into the run's `work/` as `<id><extension>`, verified by size and hash, on `--live` and with `--fetch-sources`; a no-key run uses the files the demo commits. A file that is not the checked bytes is refused, naming what was checked and what came.
A demo whose files depend on the input passes `sourcesFor(input)` (items `{ id, url, bytes, sha256 }`): only those are fetched, and a no-key run that lacks their files is refused in one line naming `--fetch-sources`. Downloads are kept by hash in `--cache <dir>` (default `agentrun-sources` in the OS temp dir), so a re-run does not fetch again; a cached copy that no longer has the checked bytes is fetched again.
A `sources.json` also lists `pages` (visited live by the agent, with their URLs and hand-check dates): they are passed through untouched, never fetched or refused. A `sources` path starting `examples/` is read from the repository root.
