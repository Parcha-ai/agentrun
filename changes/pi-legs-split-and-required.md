---
packages: repo
kind: ci
---
**Each pi leg runs as two jobs, and verify now fails unless every pi leg passed**
- A pi leg ran every suite one after another, and took 25 to 30 minutes against its 30-minute limit: one 1.3.0 leg was cancelled while its suites were still passing.
- `scripts/pi-leg.mjs` gains `--tests <names>` and `--tests-except <names>`. CI runs each leg as `pi-1-2 (<pi>, first)` and `pi-1-2 (<pi>, rest)`, with the same names in each. Each suite runs once, a new pi workspace runs in `rest`, and both jobs install and check the whole family.
- `verify (<node>)`, the required check, now needs the pi legs too. A leg that failed, was cancelled or was skipped fails it, so the merge queue waits on the pi legs. Every other side job stays advisory.
