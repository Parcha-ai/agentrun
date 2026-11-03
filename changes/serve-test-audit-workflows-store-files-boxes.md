---
packages: @parcha/agentrun-serve
kind: ci
---
serve's workflow, decision, store, file and box tests drop the ones that replayed a sibling's setup to check one more field, and keep each check inside the test that already proves the same contract. 20 tests go, and what each one checked moved into its keeper first.

- Decisions: Jev's request and receipt are checked in the estimate-pricing test, the no-key save warning and 409 in the test that checks the 409 against the served document, every capability reason and the Parallel-only server in the capabilities test, and the route's timeline row in the judge's timeline test. The receipt-provider test is gone because the Parallel-and-Jev test already checks both providers.
- An escalated run's `state` (idle), its missing output, its review against the served schema and the 501 on a message are checked in `workflow.test.mjs`'s escalation test. A plain run's `review: null` is checked in the happy-path test.
- PUT definition's two bodies are checked in `openapi.test.mjs`'s changed-operations test. The agentic-agent commit race runs in `store-busy.test.mjs`'s held-commit test, which now holds commits of any kind. A healthy volume's restart is checked in `upgrade.test.mjs`'s already-started-volume test.
- Files: the U+2060 and U+034F segments are checked by the home routes, a directory link by the run-files test, and a link inside work/ by the walk's refusal test. `file_ids: []` is checked in the file_ids refusal test. A box record's 0600 rides on the uploads and tool-keys keepers, both now run under umask 022.
- Box sweep: a record with no writer is checked through `settleBox`, and an agent archive's teardown in the archive-scope test. The cgroup-reap test went because it only checked what its scripted host returned.

Tests that passed without testing anything now check the real thing. The pause test waits for the run's live view before it checks that nothing started, not for 3 s, and drops a check on a file nothing writes. The mid-map pause test waits until every sent decision has its receipt, not for 3.5 s. The OpenRouter judge test checks the receipt's provider and model and the key the request carried. The workflow-agent test lists a run with its kind. Two store-busy tests let go of the store once the run's end has met it, not after a fixed sleep. The upload test checks that a message during the copy is answered "still being copied" with no process started. The box-sweep ordering tests fail at once when a run is answered or spawned while the sweep holds its reap. The /proc start-time test checks the field against the boot time and the process's uptime.

`writerGone`, `plainSegment` and `sameEntry` are no longer exported, and the box sweep's unused `startOf` parameter is gone.
