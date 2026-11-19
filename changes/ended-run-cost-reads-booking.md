---
packages: @parcha/agentrun-serve
kind: feature
---
An ended run whose end stored its cost unknown, because its read of the run's booking failed or ran past its bound, no longer reads `cost.usd: null` on `GET /v2/runs/{id}` (and the runs list's `RunSummary`) while that booking is priced. The run read reads the booking itself, as it already does for an ended run's figures since v0.1.0-beta.39, so the next read gives the booked total, with `all_in_usd` beside it. A charge of no known cost still reads `usd: null` with `unpriced` and `so_far_usd`, as before. When the booking has no request to read either, the run's `Cost` says why in a new field, `unknown: "booking_unread"` (costunknown/1), never a bare null: a reader that bills holds the run, as on any null. The stored cost that `/stats`, `/usage` and the learning bill read is unchanged: they keep counting that run as unknown, which holds there too. The console says "Unknown · cost not read" for it.
