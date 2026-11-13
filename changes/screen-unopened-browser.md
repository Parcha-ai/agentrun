---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
The console's Screen tab no longer says "Waiting for the browser" for a run that never opened one. `GET /v2/runs/{run_id}/computer`'s `none` answer now carries `session`, read from the run's journal: `unopened` (no browser step so far, so a run that only used `web_fetch` while it waits for its person), `opening` (a browser step that opens one has no result yet; a desktop or a phone from the run's start until its screen is up) or `closed` (the run opened one, which is not up now). The tab waits only while it is `opening`; it says "This run hasn't opened its browser. The agent's page shows here if it opens one." for `unopened`, that the browser isn't open now for `closed`, and "This run didn't open its browser." on an ended run that never did. A desktop or a phone is said in its own words.
