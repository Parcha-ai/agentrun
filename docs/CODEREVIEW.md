# CODEREVIEW.md: AgentRun (Parcha-ai/agentrun)

What the code reviewer holds a change to here, read from the base branch; it adds to the template's baseline. Edit it
like code; keep it under 6 KB. Drafted from 4,218 Greptile findings and 139 of our reviewer's threads on PRs #1-#2328.

## What this repo is

A workflow language for agents a host already runs (`packages/dsl`), the pi extension and hosts around it, and AgentRun
Server (`packages/serve`: a `/v2` API over one store, SQLite or Postgres, and a runner in `src/runner/` that claims and
runs each run), with its console (`apps/console`), clients (`packages/client`, `python/`) and computers
(`packages/computer`). AGENTS.md is the contributor guide; this file is what a review holds a change to.

## House rules

- A behavior change comes with a test that fails before it. A test that can't fail is a P1.
- Breaking changes and failure behavior get a `changes/<slug>.md` fragment; never edit an `Unreleased` section.
- The engine is policy-agnostic: budgets, provider config and SOP text live in the host, never in the interpreter.
- No backwards compatibility before 1.0: no migrations, legacy readers or shims.
- Public repo: no machine paths, internal hostnames, credentials or customer data in code, tests or docs.
- A change to modeled recovery behavior (`workflow.ts` recovery hooks, `RecoveryStore`, `pi-durable-disk/src/door.ts`)
  changes `spec/receipts` or `spec/lean` in the same PR, or says why not.
- Generated, never hand-edited: `docs/dependencies.md`, `packages/dsl/schema/`, `skills/author/references/`,
  `packages/client/src/operations.generated.ts`, `python/agentrun/_generated.py`. Review the generator's input
  instead; a generated diff that drops a field is evidence about its source (`packages/serve/src/openapi.ts`).

## Priority, by example (adds to the reviewer's baseline)

- P0: a held key reaches a log, timeline, preview, model or response (#1601: args cut before redaction).
- P0: unknown spend booked as $0 (`?? 0`), so a capped run spends past its cap (#2232).
- P0: an unauthenticated caller or a run's own code reaches a write, a shell or a path outside the workspace (#1946).
- P0: store or journal rows lost or duplicated on a normal commit (#2042: two commits share a sequence number).
- P1: a lost claim, crash, cancel or stop leaves work running or a write landing (#2273, #2189, #2198).
- P1: `openapi.ts` disagrees with the server, so the generated clients drop a field (#2214).
- P1: an error path reads as success (#1980: a GitHub 5xx read as "no repositories").
- P2: a deleted trigger keeps a broken link in the console (#2076); a bounded per-run leak.

## Never flag

Each class below was declined here, most more than once:

- Code this PR didn't write: a stacked base, a merge of main, a file moved byte for byte (27 declines). Check the
  hunk is this PR's. A defect it now triggers is pre-existing, in the summary.
- Old data, rows, servers or clients losing something on upgrade (8 declines): see the no-compat rule.
- A deferral the author already named (a `changes/` limit, the PR body, a filed issue), and a follow-up re-raised on
  another PR. Respect a decline that names its tradeoff and a test pinning it.
- By design: the DSL's `budget_usd` is never enforced by a runner (serve's cap is); `retry.on` retries on a listed
  class or code; `deniedGlobalReferences` is a fail-safe lint; an empty env value counts as unset; a drain still
  accepts a `submit`; a webhook moment while no webhook is set is never sent.
- A flaky test removed or quarantined (CONTRIBUTING.md), tests for test helpers, new tests on a parity port.
- JavaScript `$` without the `m` flag matching before a trailing `\n`: it doesn't (2 wrong findings).
- Quadratic work on input already bounded (paths at 4,096 bytes), README wording the founder set.

## Checklist: this repo (adds to the baseline's eleven)

- `cap.ts`, `runner/metrics.ts`, `packages/run-adapters/src/**`: does an unknown (`null`) spend become a number?
- `secrets.ts`, `secret-cut.ts`, `runner/{live-ticker,redact}.ts`: is text cut, previewed or streamed before whole
  values are redacted; is a launcher secret read from `process.env` instead of `secret(NAME)`?
- `runner/**`, `store/**`: does a write after a claim skip the claim's fence; does a spec build that throws leave what
  it made running?
- `triggers.ts`, `github-connection.ts`, `tool-gate.ts`: is state read before an `await` written back unchecked; does
  something live only in the 200-entry firing history?
- `workspace/**`: can a parent swapped for a symlink mid-call move a path outside the root?
- `openapi.ts` with a route change: does the document still match what the server takes and answers?
- `templates/**`: does a skill need a file apply doesn't copy (only `skills/`, `rules/`) or a field the server never
  writes?
- Store claims: SQLite and Postgres share one `storeOver` (`store/sqlite/store.ts`): never claim a second one.

## Verify a claim cheaply

- `server.ts`, `openapi.ts`, `workflow.ts`, `cap.ts`, `runner/adapter-loop.ts` are over 100 KB: fetch one only to
  settle a fact, once, then `read` its filed copy at an offset.
- Who calls it: `search_code` (default branch) with the symbol and `repo:Parcha-ai/agentrun`, then read that caller.
- Deliberate or not: the test beside it (`packages/<pkg>/test/`), `changes/*.md`, the comment above the line.
- A claim about which value a caller passes, where a value comes from or which scope a name is in needs that line
  read: 7 of our reviewer's 13 declined findings skipped that hop.

## Limits

- P2: at most 4 on a full review, 2 on a push. Pre-existing: at most 3. At most 10 findings in all.
- Docs findings: at most 1, only when they now mislead a caller.

## Repo knowledge

`.agents/skills/code-review-knowledge/SKILL.md`: invariants and past defects by path glob.
