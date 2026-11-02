---
packages: repo
kind: feature
---
The console archives runs and filters the runs list, as the server's own page does. A run's page has **Archive** (or **Unarchive**) in its header, and an archived run shows an Archived chip there. The runs list has a state filter and an **Archived** toggle that lists only archived runs. The address keeps both (`#/runs?status=failed&archived=true`, beside `agent=`), so a reload keeps the view. The client's `archiveRun` and `unarchiveRun` send the empty JSON body a cookie write needs, and `listRuns` and `listAgentRuns` take `{ status, archived }`.
