---
packages: repo
kind: feature
---
The place answers where a kill request is written (`Place.requestFile(attempt)`), and the child writes it durably (a synced temporary file, renamed, the directory synced). The supervisor mints a random nonce for each attempt (`KILL_NONCE`, which the child reads once and removes from its environment) and honors a request only with that nonce, writing a `kill.request.ignored` host line for one without it. One fresh run id per invocation (`<demo name>-<8 hex>`, `DemoResult.runId`) reaches the place as `paths.id` and the child as `RUN_ID`, so a second run of one demo on a shared disk never finds the first's run or signals.
