---
packages: repo
kind: feature
---
`@parcha/agentrun-pi/durable` stores a run's decision rows in pi-durable: the session document `agentrun.decisions` (document version 1, row version 1), `appendDecision`, `readDecisions`, and `createDecisionWriter({ open })`, which commits rows in the order they are recorded, opens the run's Session on the first row, reports the first failed commit from `settled()` and `flush()`, and releases the Session in `flush()` even after a failure. The entry point now imports pi-durable and chord at runtime; both stay optional peers of the package, needed only by a host that imports `./durable`.
