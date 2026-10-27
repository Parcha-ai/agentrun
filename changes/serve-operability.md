---
packages: @parcha/agentrun-serve
kind: fix
---
AgentRun Server is easier to run: a stop ends within the platform's grace, the token link takes any token, and stdout says what happened.

- `--drain-timeout D` sets how long a busy run may finish its turn when the server stops (default 30s), and the image's command sets 6s, so a busy stop ends in about 7.5 s, inside Docker's default 10 s grace, so a busy `docker stop` no longer ends in SIGKILL (exit 137). Compose sets `stop_grace_period: 15s`. Render waits 30 s and does not let a service with a disk change it, which `render.yaml` now says. A turn cut off resumes at the next start.
- The page's `/?token=` link signs in with a token holding `+`, `/` or `=` whether it is URL-encoded or not (a `+` sent raw arrives as a space), and the printed link encodes the token. Before, Render's generated tokens often had a `+`, and the documented link answered 401.
- stdout gets one logfmt line per request (method, path without its query, status, ms), per run start and end (run, agent, status, cost) and per refused credential (route and reason, never the token or any part of it). `AGENTRUN_LOG=quiet` leaves out the request lines. A run whose process failed at its start says why in words, not as the process log's raw JSON.
- `DIR/.token`'s token is printed only by the start that made it; a later start prints `AGENTRUN_API_KEY=<in DIR/.token>` and `?token=<in DIR/.token>`. `startServe` returns `tokenMade`, takes `log`, and `banner` is exported.
