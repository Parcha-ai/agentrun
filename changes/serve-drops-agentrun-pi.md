---
packages: @parcha/agentrun-serve, repo
kind: breaking
---
The server's workflow engine moved in from `@parcha/agentrun-pi`, with no fallback to it:
- `@parcha/agentrun-serve` no longer depends on `@parcha/agentrun-pi`. If your code imported agentrun-pi because the server brought it in, add `@parcha/agentrun-pi` to your own dependencies.
- The research example (`npm run demo:research -- --live`) no longer falls back to a saved Pi default for its agent steps. Pass `--config ./your-adapters.mjs` with a module that default-exports `{ runJudge, runNode }`; `examples/pi-config.mjs` is gone.
