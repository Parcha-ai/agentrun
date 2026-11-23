---
packages: @parcha/agentrun-serve
kind: fix
---
A parked run whose desktop, phone or sandbox was kept at its park on a Docker engine, or on a machine that dials the server, now resumes on the runner that kept it while that runner is there (its word in the last 30 s, the same process, not refusing) and the keep's 10 minutes last, so a server with several runners gets the same machine back instead of a new one and no longer leaves the kept container running with nothing to end it. Another runner claims nothing for that run meanwhile, and its computer janitor leaves the kept row to that runner. Once that runner is gone, any runner claims the run, starts a new machine, and the timeline says `The desktop wasn't kept: the runner that kept it is gone.`; a run kept on an exec vendor's machine or a phone is claimed by any runner, as before. The kept row (`computer_kept:<run id>` in settings) names the runner and its incarnation; there is no schema change.
