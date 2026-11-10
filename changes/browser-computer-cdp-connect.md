---
packages: @parcha/agentrun-serve
kind: fix
---
An agent whose computer is a Browser (Browserbase, Kernel or Local Chrome) now runs on a real server, where it used to fail at its claim with "it gave no CDP connection". The claim starts the browser through its provider, and the run's browser tool drives that one session over the provider's CDP URL with pi-browser's raw-CDP driver. Its session time, live view and hand-off work as the `browser` tool's always have, and no `browser` grant is needed. The model drives it with snapshot ids and actions (`run.code` is refused on a browser computer).
- A pi agent gets the browser tool from its computer. On Codex, Claude or another CLI harness, a browser computer is refused at the run's start, saying that only pi drives it.
- Local Chrome's session time is priced at $0.
