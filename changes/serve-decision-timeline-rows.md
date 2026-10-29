---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A workflow run's timeline shows its decisions. Each decision its `judge`, `pick`, `sift`, `route`, `ask` and `verify` nodes recorded is a row of kind `decision` once the run has ended:
- its summary names the node and the provider that answered, then each answer with the probability of what it said (`coi (jev): is_coi yes 0.92`), or for a route the branch it took (`route: review`, with `unsure` or `refused` when that is why);
- its text lists the sources the provider cited (title, then URL) and the questions it refused;
- its `usage` carries its own cost, and the run's usage row adds it in once: one unknown cost makes the total unknown, never a lower figure.
A request that fails after it was sent (a 408, a 5xx, a lost connection) is sent once, and the run escalates it as an interrupted decision for review. `TimelineKind` gains `"decision"`.
