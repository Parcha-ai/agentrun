---
packages: repo
kind: fix
---
A recorded blob is written to a temporary file in the recording's `.spool/`, synced and renamed into `blobs/`, so a viewer following a live run never fetches a half-written one and a killed write leaves no torn blob; the validator and the gate are unchanged. `browser: false` in demo.json means the entry creates no browser, live or on fakes (a `--live` run then needs no Browserbase key and no Chrome), and a page call fails with `this demo has no browser`.
