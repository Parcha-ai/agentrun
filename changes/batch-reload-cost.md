---
packages: @parcha/agentrun-serve
kind: ci
---
The learning batch restart test no longer ends now and then with the batch `stopped: cost_unknown`. Its in-process runner stopped with no drain, so a stop that landed while a row's model request was out cut it, that request's cost stayed unknown for good, and the batch stopped on the row as its cap rule says. The CLI's runner drains at a stop (`--drain-timeout`, 30 s by default), so a turn in flight finishes and is booked; the test's runner now drains the same way.
