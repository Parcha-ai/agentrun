---
packages: @parcha/agentrun-harness
kind: fix
---
A recording, and the run's own `events.jsonl`, no longer hold a browser session's live-view URL: the reference host writes each session row (`launched`, `updated`, `released`) with `liveView: null`. A viewer's address is a full-control token, and a recording is read by anyone who has it. The reference host shows no session to a person, so nothing of its own needs the address; a host that does asks the provider for it (`BrowserProvider.liveView(ref)`), never the recorded row.
