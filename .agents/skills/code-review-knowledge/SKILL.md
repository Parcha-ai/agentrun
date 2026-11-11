---
name: code-review-knowledge
description: "Invariants and past defect patterns of Parcha-ai/agentrun, keyed by path glob. The code reviewer reads it from the base branch and applies only the sections whose glob matches a changed path. Use when reviewing a change, or before changing code under one of the globs below."
---

# Review knowledge: AgentRun

Each section is a path glob, then the invariants that broke before there, with the PR where a reviewer caught it. A
pattern is a lead to check, not a finding: prove it against the change. Built from 2,766 fixed Greptile findings,
our reviewer's threads and the learned review notes, PRs #1-#2328. Keep it under 10 KB; split an area into its own
file under `references/` and link it here when it grows.

## Money: `packages/serve/src/{cap,budget,decision-cap}.ts`, `packages/serve/src/runner/{metrics,model-route}.ts`, `packages/run-adapters/src/**`

- Unknown spend is `null` and stays unknown: `?? 0` on `spentUsd`/`bookedUsd` books it as $0 and lets a capped run go
  on (#2232 cap.ts, #1952 port.ts, admit.ts). A zero-dollar hold is still booked.
- A request sent with no turn yet still counts (#2303). A lost request keeps its bound (#1979). A retried settle after
  a failed end-mark write books once (#1952). A hold saved before admission is not spend (#1861).
- The DSL's `budget_usd` is the host's: no runner enforces it (by design).

## Secrets: `packages/serve/src/{secrets,secret-cut,tool-keys}.ts`, `packages/serve/src/runner/{live-ticker,redact,store-secrets,claim-secrets}.ts`, `packages/serve/src/learn/secrets.ts`, `packages/run-adapters/src/host/proxy.ts`, `packages/pi-durable-agent/src/timeline/**`

- Redact whole values before any cut: a 300-character error, a 2 KiB args preview, a first line (#1601, #2323). Titles
  and labels come from the redacted text (#1573); a verdict (failed/ok) comes from the raw one (#1573).
- Every form of a held value: as written, JSON-escaped, slash-escaped, both (#2026), a bare JSON number (#2185), hex in
  any case, a split pointer (#2074), and a value streamed across two ticks (#2185, #1577).
- Launcher secrets are not in `process.env`: read them with `secret(NAME)`; a `withSecrets` env holds them
  non-enumerable, so a spread drops them (#2073). An env passed for a non-secret setting is fine (our wrong #2092).

## Runner and store: `packages/serve/src/runner/**`, `packages/serve/src/store/**`, `packages/serve/src/store-reads/**`

- Every write after a claim is fenced by it; a loop that lost its claim still runs `spec.release` (#2273). A delete by
  run id checks the claim, or a late loop erases the new runner's row (#1969).
- A spec build that throws releases what it made: register a computer before any `await` that can fail (#2189, #2171).
- A person's stop sets the adapter loop's stop state; `run.signal` is not aborted by it, so a new wait must watch the
  loop's stop (#2198).
- A crash between two commits: what the first owed is recorded and redone on resume (`rootWritesOwed`, #2273; a
  learning merge before `learningMerged`, #2256).
- Leases are computed after the writer lock is held (#1955); a failed `COMMIT` rolls back (#1955); Postgres
  `FOR KEY SHARE` does not serialize a run-ending patch (#2042); schema lock ownership is re-checked (#2263).
- SQLite and Postgres share `storeOver` (`store/sqlite/store.ts`): one `runs.list`, one domain code (our wrong #2120).

## Triggers and GitHub: `packages/serve/src/{triggers,webhooks,github-connection,github}.ts`, `packages/serve/src/runner/{mcp-github,github-app}.ts`

- Firing history keeps 200 entries: an active run id, a seen webhook id or a run-now key kept only there is lost
  (#1622, #1649, #1953).
- State read before an `await` is checked again before it is written: installation events (#1980), `update()`'s
  captured `source` (#1622), a token refresh racing a disconnect (#2241).
- GitHub 403 rate limit, 429 and 5xx are "unavailable", not "covers no repository" (#2024, #1980); a store read error
  is not a disconnect (#2241); every minted token is revoked (#2241).

## Tool gate and MCP: `packages/serve/src/{tool-gate,tool-plane,tools,mcp-gateway,mcp-oauth,mcp-meta,mcp-secret-writes}.ts`

- A server deny beats an agent ask; an invalid permission never becomes allow (#2003, #1714).
- A malformed pin keeps its protection when another setting is saved (#1990).
- "Nothing was sent or charged" only when no request left (#1814).
- Hostnames: a trailing dot (`klavis.ai.`) still matches the refusal (#1746).

## Workspace and computers: `packages/serve/src/workspace/**`, `packages/computer/src/**`

- Containment holds against a parent swapped for a symlink between check and use (#1946, #2260).
- Replacing a file: the temp file takes its final mode after the last chunk (0444, 0200; #1957), and is synced
  before the rename (#1957).
- Output caps apply while streaming, not after exit; deadlines bound searches and regexes (#1968, #1946).
- Docker: a late create after an abort is removed with `--volumes` (#2218); two stagers never delete each other's
  finished tree (#2180, #2188).

## Server, API and clients: `packages/serve/src/{server,openapi,cli,import}.ts`, `packages/client/**`, `python/**`

- `openapi.ts` matches the server: a repeatable query parameter, a response shape, an error code (#2214, #1876,
  #2100). The generated TS and Python clients follow the document, not the server.
- Shutdown waits cover `runner.close()` (#2267); work started at shutdown is awaited or stopped (#1778).
- No server-wide place is held before auth (#2115).
- Python client: the timeout covers DNS, every failure reaches the error handlers, scrubbed (#1981).

## Learning: `packages/serve/src/learn/**`, `packages/serve/src/runner/{learning-*,reflect-hook}.ts`, `packages/serve/src/{learning,learning-routes,learned-workflow}.ts`

- Front matter is YAML: explicit `? key`, trailing comments and `\x`/`\U` escapes parse as YAML does (#2255).
- A draft's dry run is untrusted: bound its schema expansion and loops (#2293).
- A note and a skill can collide on one file name; duplicate checks run inside the retried commit (#2256).

## Templates: `packages/serve/templates/**`, `packages/serve/src/{templates,template-eval}.ts`

- Apply copies only `skills/` and `rules/`; a schema the agent must meet ships beside its SKILL.md (#1977).
- A skill gates only on fields the server writes (`inputOf`, triggers.ts) (#1956); schema limits fit the skill's
  rules (#1992).
- The eval runner cancels a run it started when a case fails, and an eval apply never arms the real triggers (#1990).

## Console: `apps/console/**`

- Overlapping reads: the newest answer wins, and Retry is off while one is pending (#2223).
- A restart or hand-off carries everything the first request had, `file_ids` too (#2269).
- One id per control (#2055); colours, sizes and controls come from `src/tokens.css` and `src/components/ui`.

## DSL: `packages/dsl/**`

- `validateWorkflow` returns problems, never throws (#1251).
- Lookups by a name use own properties: a question id like `constructor` breaks a plain `{}` (#1180, #1202).
- Schema walks follow nested `anyOf` and `$ref` (#1115). Spend and its end mark go in one commit (#1177).
- By design: `retry.on` retries on a listed class or code; `deniedGlobalReferences` is a fail-safe lint.

## Hosts: `packages/pi-transport/**`, `packages/pi-durable-disk/**`, `packages/pi-durable-agent/**`

- Without `/proc` (macOS) process cleanup still ends what it started (#335, #1644).
- An `lstat` error other than ENOENT is a failure, not "missing" (#1344); byte budgets count metadata (#1343).
- A recovery that changes `door.ts` changes `spec/receipts/Door.tla` (AGENTS.md).

## Scripts and CI: `scripts/**`, `.github/**`

- Guards that scan source with regexes miss renamed imports and bracket access (#1967, #1918).
- A release compares against the last published version, not the PR's base (#2182).
