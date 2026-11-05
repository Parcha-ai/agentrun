---
packages: repo
kind: fix
---
The schedule form says the cap's rule before an agent is picked ("Required unless the agent has a default cap per run."), offers no amount to copy when the cap may be left to the agent's default, and says under the cron line that `* * * * *` is every minute. A schedule's page reads its agent's default cap again with each refresh, so a change made elsewhere shows, and an amount read for one agent never shows for another. Schedules is always in the nav: the console ships inside the server, which always has them.
