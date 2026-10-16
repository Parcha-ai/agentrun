---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. This first part holds the contract a guard implements (`Guard`, `GuardInput`, `Refusal`) and the
types a `learn` call records (`Candidate`, `LEARN_TYPES`, `ENTRY_TYPES`).

`guard` is the structural check every writer runs before anything reaches git (`createGuard` sets its caps). It refuses and
never redacts, makes no model call, and never repeats a value it refused. It finds a host secret as written, split over
lines, as base64 or base64url at any alignment, as hex in either case, and percent or form encoded; secret shapes (cloud
keys, private-key blocks, tokens, a URL with a password); invisible and bidirectional characters, with emoji sequences and
the joiners of scripts that need them allowed; any value from the run's input (case data); each role's own paths (a run
writes its inbox and uses files, the curator writes learnings, skill folders and the workflow store; `AGENTS.md`, `agent.json`
and any `.git` segment never, in any spelling); and size and count caps. `proposeLearning` is the host step at a run's
terminal: it collects the run's candidates, renders `inbox/<run id>.md`, guards the whole proposal, and makes one commit on
`runs/<run id>` through `@parcha/pi-git-remote`, pushed by sha. A guard hit refuses all of it and commits nothing; a second
call, including one from a restarted host with an empty local repository, commits nothing. `renderInbox` and `parseInbox`
are the inbox's format.
