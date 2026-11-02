---
packages: repo
kind: feature
---
The console says how much a run whose requests were cut can have cost. Where a run's cost is unknown but the server bounds it (`at_most_usd`, set only when every cut request has a recorded figure), the run header and the run rows read "≤ $x" with "some requests were cut", in place of "Unknown". A bound is rounded up, so it never reads below itself, and is never a bare "$x". Mission Control's total cost and the analytics' cost keep the known sum and add "up to $y more for N cut runs" from `/v2/stats`' `bounded_unknown` (the analytics' under their range and agent). A server without these fields reads exactly as before.
