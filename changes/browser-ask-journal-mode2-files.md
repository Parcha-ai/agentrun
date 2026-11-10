---
packages: @parcha/agentrun-serve
kind: fix
---
On the runner, the agent's browser hand-over ask is recorded only in the run's journal: no `browser-ask/<id>.json` file is written in the run's workspace any more, so neither the run's file list (`GET /v2/runs/{id}/files`) nor the agent's own file tools see an ask's record, and a file planted there changes nothing. In Mode 2, what the browser files (its evidence, the downloads `browser_downloads` copies, the files `browser_upload` reads) goes through the run's Workspace, on the run's Archil disk, where the run's own read finds it, not to this machine's local folder.
