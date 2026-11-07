---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve, @parcha/pi-durable-disk
kind: breaking
---
The code taken from vercel-labs/durable-harness is now AgentRun's own: the port froze, and the pristine upstream copies, the named patches, the import tables, `scripts/port-durable-harness.mjs` and `npm run verify:port` are gone. `vendor/durable-harness/UPSTREAM.json` still records where each copy came from, and each copy keeps its header and NOTICE its attribution. With it go the kernel's paths that never run:
- `AgentAdapter.version` and `AdapterCapabilities.fork` (no adapter forks; a node that asks for `context: "fork"` is refused as before).
- `DriveContext.config`, and `requires`/`needs` on a host tool and an effect's options; `kernel/types.ts` is no longer pinned to upstream's types.
- The Codex harness's `codex.spend` ledger and its dollar caps (`sandbox({ budget })`, `GatewayLedger`, the gateway handler's `budget`, `ledger` and `onCap`), which never fired, and its table of removed options.
- `Box`, `BoxSpec`, `BoxedChild`, `Isolation`, `BoxError` and `boxSlot` (`@parcha/agentrun-kernel/host`), which nothing implemented or used.
- The model proxy's parts only tests used (`inputTokensMaxOf`, `matchRoute`, `parseStrict`, `reportedCostOf`) move to `@parcha/agentrun-kernel/testing`; `providerIdsOf` and `MCP_ROUTE_VERSIONS` leave the host API.
- The box egress proxy (`startEgressProxy`, `parseAllow`, the address table) moves into agentrun-serve, its one user.

Fixed: a run on Claude Code or Codex now closes its harness session when its process lets the run go, as the adapter's `close()` contract asks; before, serve never called it. On today's adapters an idle session's `close()` stops no process of its own (each drive already ends its CLI or app-server when its turn ends), so this keeps the contract for an adapter whose session holds one. For it, pi-durable-disk's `DoorHook` has a required `close()`: the door's stop calls it once, busy or idle (on a drain after the abort, on a fence alongside the kill, within the abort's bound). A hook with nothing of its own to stop resolves at once. `DoorHook` also has a required `harness` id: a `close()` that throws, rejects or overruns its bound is logged with it ("door close failed" / "door close timed out") through `serveRun`'s new optional `log`, which the run CLI passes its log line to. A harness session that lands after the door's close (a stop while it was still opening) is closed too, once.
