---
packages: @parcha/agentrun-dsl
kind: fix
---
A `call` node's poll that runs out of time fails one way: `call node "<label>" poll exceeded its <n>s deadline after <k> check(s)`, a `timeout`, with one `effect.poll` event settled `"deadline"` for the last check started. `<k>` counts the checks started, including a last check that the deadline stops before its effect begins. Before, a wait that woke past the poll deadline (a slow timer, or a retry's backoff) and a check the poll deadline cut failed with the same text but no count, and sent no `"deadline"` event; which one a run got depended on how late its timers fired.
- Each check sends exactly one `effect.poll` event. A check that does not settle now sends `settled: null` after its interval wait, just before the next check starts, instead of before the wait; its `elapsed_ms` is unchanged (the time when the check ended). A wait that ends at or past the poll deadline sends `settled: "deadline"` for that check instead.
- A check the poll deadline cuts is counted, and its `effect.failed` message carries the same counted text.
- A poll run under a recovery driver does not change, including the text without a count when the poll deadline cuts a check.
