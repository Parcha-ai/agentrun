---
packages: repo
kind: feature
---
The console's agent page opens on the agent's latest run, above its runs: its status, its title, when it started, its timeline as the run page shows it, and a link to the whole run. While the run goes, its timeline follows it from the cursor, and when the run's status moves, the run is read again, so its badge and its row in the list move together. A read that fails is tried again, even after the timeline's last page; one that keeps failing says the run could not be refreshed, with a Retry, rather than show the old status. An agent with no runs says so, and that its first run will show there. The page reads what it read before (the agent's runs, the run's timeline and the run), with no new server route.
