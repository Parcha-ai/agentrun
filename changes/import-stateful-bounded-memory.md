---
packages: @parcha/agentrun-import
kind: feature
---
`parseHome` with a `state` keeps each request as its counts in the cursors it holds between passes, not as a request object, so a caller that keeps a `HomeState` imports a large history in bounded memory, as the CLI does: on a 1,412-session history the state goes from 111 MB to 48 MB, with the same answers. A `HomeState` kept by beta.55 or earlier is set aside, and the next pass reads every source from its start, as a fresh one would (#3614).
- `ReadOptions.totals`: with `turns: false`, a read keeps only each request's model, usage and time, in the new `SessionRead.counts`, with `requests` empty. A `lineReader` gives that read only when its `LineSource` sets `totals: true` (Claude Code's, Codex's and pi's do); any other reader returns its requests whole, as before.
