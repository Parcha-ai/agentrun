---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow whose model node names `browser` (or `read`, `write` or `edit`) is now refused when it is saved, saying why and what to do, instead of being accepted and then failing when its run starts. A definition saved before is refused at its run's start (409), with no run made. Capabilities' `workflows.node_tools` and each tool's `nodes` now list only what a workflow's model node can use here: `web_fetch` and `web_search`.
- A browser whose vendor will not release it when the run ends is no longer passed over silently. The runner logs it, and the run's journal keeps an `agentrun.browser.unreleased` marker naming each session still held, for a reconcile or a sweep to release and book.
- A kernel fault's restart now closes the previous pass's in-memory browser (its live-view server, person holds, idle timers and driver attachments) before the next pass binds the tools again.
