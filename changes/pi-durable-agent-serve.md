---
packages: @parcha/pi-durable-agent
kind: feature
---
`npx @parcha/pi-durable-agent serve <dir>` serves a local page over an agent home, read from its SQLite files directly and read-only (the new `pi-durable-agent` bin; `serveHome(home, { port?, signal? })` from `@parcha/pi-durable-agent/serve` is the same from code). It listens on `127.0.0.1` only, takes no lock, creates nothing in the home, reads only the kinds an export may carry (never a saved sign-in, session, lease, binding or alias), and answers `GET` and `HEAD` for a `Host` that is its own. `/api/agent`, `/api/runs` and `/api/runs/:id` give the agent, its runs and a run's timeline rows as JSON.
