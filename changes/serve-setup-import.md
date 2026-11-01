---
packages: @parcha/agentrun-serve
kind: feature
---
Setup can import this machine's Claude Code, Codex and pi sessions. It runs only on a server on that machine: listening on loopback, with no public address.
- `GET /v2/setup/import`: before the owner exists, this server's own page reads how many projects and sessions it would import (`{ projects, sessions }`); any other read is a `403`. Once the owner is set, the signed-in owner reads how the import asked for at setup stands: `{ state: "running" }`, `{ state: "done", agents, runs, skipped }` or `{ state: "stopped" }`. Everyone else, and a server at a public address, gets a `404`.
- `POST /v2/setup` takes `import: true` to import once the password is set, and then answers `importing: true`. Agents arrive as the import goes. A server at a public address, or one listening off loopback, refuses it with a `422` (field `import`) and sets no owner.
- The owner's yes is kept in the data directory (`.import-at-setup`) until the import ends, so a server stopped mid-import goes on with it at its next start. Closing the server stops the import between two sessions and waits for it, so nothing writes the store after close.
