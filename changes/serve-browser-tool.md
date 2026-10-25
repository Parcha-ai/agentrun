---
packages: @parcha/agentrun-serve
kind: feature
---
A revision may name `browser`: a Browserbase browser on `@parcha/pi-browser`'s durable adapter (`snapshot`, `run`, `screenshot`, `browser_read`, `browser_release`, `browser_relaunch`, and downloads and uploads in the run's `work/`), for an agent and for a workflow's model node. It needs `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` in the server's environment, which reach the run's process; without them capabilities list it unavailable with the missing names, and a run of a revision naming it is `409 agent_not_runnable`. A session's custody stays in the run's own store, each page read is filed under `work/evidence/`, there is no recording or live view, and the sessions a run still holds are released when the run is let go. agentrun-serve now depends on `@parcha/pi-browser` and the `@browserbasehq/sdk` it drives Browserbase with.
