---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: breaking
---
The code taken from vercel-labs/durable-harness is now AgentRun's own: the port froze, and the pristine upstream copies, the named patches, the import tables, `scripts/port-durable-harness.mjs` and `npm run verify:port` are gone. `vendor/durable-harness/UPSTREAM.json` still records where each copy came from, and each copy keeps its header and NOTICE its attribution. With it go the kernel's paths that never run:
- `AgentAdapter.version` and `AdapterCapabilities.fork` (no adapter forks; a node that asks for `context: "fork"` is refused as before).
- `DriveContext.config`, and `requires`/`needs` on a host tool and an effect's options; `kernel/types.ts` is no longer pinned to upstream's types.
- The Codex harness's `codex.spend` ledger and its dollar caps (`sandbox({ budget })`, `GatewayLedger`, the gateway handler's `budget`, `ledger` and `onCap`), which never fired, and its table of removed options.
- `Box`, `BoxSpec`, `BoxedChild`, `Isolation`, `BoxError` and `boxSlot` (`@parcha/agentrun-kernel/host`), which nothing implemented or used.
- The model proxy's parts only tests used (`inputTokensMaxOf`, `matchRoute`, `parseStrict`, `reportedCostOf`) move to `@parcha/agentrun-kernel/testing`; `providerIdsOf` and `MCP_ROUTE_VERSIONS` leave the host API.
- The box egress proxy (`startEgressProxy`, `parseAllow`, the address table) moves into agentrun-serve, its one user.

Fixed: a run on Claude Code or Codex now closes its harness session when its process lets the run go, so the harness's own processes stop with it; before, a harness child ended only when its parent process died.
