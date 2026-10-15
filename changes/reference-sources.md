---
packages: repo
kind: feature
---
The reference entry fetches a demo's `sources.json` (checked files `{ id, url, bytes, sha256, license }`) into the run's `work/` as `<id><extension>`, verified by size and hash, on `--live` and with `--fetch-sources`; a no-key run uses the files the demo commits. A file that is not the checked bytes is refused, naming what was checked and what came.
