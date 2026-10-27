---
packages: @parcha/pi-durable-disk
kind: ci
---
**The live suites say what one red was, and only once**
- A red supervise test left its units and mounts up, and every later test then failed its own empty-mount-table check on them, so one red read as six. Each supervise test now leaves nothing up when it ends: an `afterEach` thaws the daemons it froze, kills its supervise loops, stops this run's units and unmounts this run's mounts, by this run's `p5-<stamp>` names only. `PDA_LIVE_FAIL_TEST=<test name>` is a test hook (in `test/live/_p5.ts`, nothing in `src` reads it) that fails one test with its instance up, to show the next one still passes.
- The serve test's cold start counted on generation 1. When a commit stalled past the new instance's lease before it answered, the request took the run over (a second, lease-expired start) and answered at generation 2, and the test failed although the run did what it should. It now asserts one generation per start in the request's ensure results, every start after the first a lease-expired takeover, and B's later takeover at the next generation.
- When a run-suite instance exits before the step its test waits for (the T14 and P4c fence tests), the failure now starts with what the archil client logged on that instance's own mount, from journald: the longest commit and the server_timeout retries, as "environment: on this test's own mount a commit took N ms, K server_timeout retries before ...". It is diagnostics only: the test fails exactly as before, and without journald the message is the old one.
