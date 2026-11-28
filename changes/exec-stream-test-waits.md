---
packages: @parcha/agentrun-computer
kind: ci
---
The exec pre-check's tests take about a third of the time they did. The tests that sit out the pre-check's own bounds on a broken exec run eight at a time, with every bound and assertion as before; the one that rewrites `Date.now` and the one that holds the event loop still run alone. The conformance CLI's `main()` takes `execStreamBounds` beside `providerOptions`, bounds over `--exec-stream`'s defaults (`longMs` over `--quick`'s too), so the CLI's test leaves stdout unread for 200 ms rather than 10 s. With no `execStreamBounds`, `--exec-stream` runs as before.
