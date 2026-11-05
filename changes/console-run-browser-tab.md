---
packages: repo
kind: feature
---
A run with a browser has a Browser tab on its page: the agent's page, live, while a browser session is open ("Browser · live" in the tab), and "Waiting for the browser" while the run can still open one (queued, working, or waiting on its question). On a run that ended, it says the browser closed with it, adding that a follow-up opens a new one only where the run takes a follow-up. On a server that serves `features.browser_live`, it reads `GET /v2/runs/{id}/browser` while the run is live, and once after it ends; a run with no browser (`off`), or a server without the route, has no tab. The session's viewer is the address of an iframe sandboxed to its own scripts and origin, and nothing else: its token stays in the address's fragment, and never reaches the console's address bar, its history, storage or a log. A new session after a release gets a new viewer, which the tab follows.
