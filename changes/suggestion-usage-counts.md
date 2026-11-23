---
packages: @parcha/agentrun-serve
kind: feature
---
The anonymous usage counts (`docs/telemetry.md`) say how suggested agents are used, with three new events: `suggestions_scanned` (a scan of a repository starts), `suggestion_discarded` (a suggestion is discarded) and `suggested_agent_created` (a suggested agent's pull request opens, once per suggestion). Each is its name alone, with the fields every event already holds; it never says the repository, the suggestion, its agent or its pull request. The same settings turn them off (`AGENTRUN_TELEMETRY=0`, `DO_NOT_TRACK=1`, CI, a test runner, `--faux`), and the start that prints the notice sends none of them: a use that day is not counted. `startServe` takes `onUsage`, which hears each event's name.
