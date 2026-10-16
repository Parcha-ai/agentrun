---
packages: @parcha/pi-durable-agent
kind: breaking
---
`createAgentHome` refuses a definition `id` that is not one URL segment, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (letters, digits, `.`, `_` or `-`, at most 128, not starting with a punctuation mark), with `AgentHomeError` (`invalid`). A caller that passed an id with a space, a slash or another character must pass one that matches, or omit it and take the minted UUIDv7, which always matches. Homes created before keep their ids, and `refreshAgentHome` still takes a home's own id. New: `homeRevision(home)`, the agent store's head commit number, which every write that changes the home moves and no read does; with the identity's id it is the home's version, for an ETag. `refreshAgentHome(home, { ..., ifRevision })` is a compare-and-swap on it, checked under the home's lock before `from` and before anything is written: a home whose head commit is not `ifRevision` is refused (`stale`), naming both numbers.
