---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run that compacted its context no longer reads its cost as unknown. pi sends the compaction's summary request through the run's model port, which marks and books it at its price, but stores no answer for it: its cost rides on the answer pi stores beside it. The Timeline's usage row counted that summary as a request cut with no answer, so it read `usd: null` with `unpriced` equal to the number of compactions, and so did every reader built on it: a running run's `cost.usd` on `GET /v2/runs/{id}`, its live spend on the runs list, and the usage line on its run page. pi's compaction entry now answers that summary request: the row reads the run's priced total, counts the summary as a request whose tokens pi did not report, and the cap's spend counts it once.
