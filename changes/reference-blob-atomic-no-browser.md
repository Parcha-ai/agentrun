---
packages: repo
kind: fix
---
A recorded blob is written to a temporary name (`blobs/.<sha>.<ext>.tmp-<pid>`), synced and renamed into place, so a viewer following a live run never fetches a half-written one; the validator, the gate and the record-time scan skip a temporary name. `browser: false` in demo.json means the entry creates no browser, live or on fakes (a `--live` run then needs no Browserbase key and no Chrome), and a page call fails with `this demo has no browser`.
