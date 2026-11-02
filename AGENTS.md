# Agent instructions

Guidance for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the
authority where the two differ. To add AgentRun to another project, use
[docs/agent-instructions.md](docs/agent-instructions.md) instead.

## What this is

AgentRun is a workflow language for agents a host already runs. A workflow is a JSON document (or
TypeScript builder output) of typed nodes; the interpreter executes it and calls back into the host
for every model call and side effect, while the host keeps its tools, models, permissions, budgets
and delivery.

## Layout

Each package's README is its API reference. Packages with no dependency on the others:
`pi-durable-disk`, `pi-browser`, `pi-vision`, `pi-transport`, `pi-git-remote`.

| Path | What an agent must know |
| --- | --- |
| `packages/dsl` | `@parcha/agentrun-dsl`: types, validator, interpreter (`src/workflow.ts`), CLI (`agentrun-dsl`). Node reference: `skills/author/references/language.md`, generated from `src/author.ts` (edit the source); judgment design: `jev-decisions.md` beside it. `schema/workflow.schema.json` is generated too |
| `packages/jev`, `packages/pi` | `runJudge` adapter for Jev, and `jevProvider` (Jev as a `DecisionProvider`); the Pi extension (`/agentrun`) and Pi-backed `runNode` |
| `packages/pi-durable-disk` | Durable pi host on Archil. Tests run on `src/*.ts`; `PDA_LIVE=1` suites need Archil (or Daytona) credentials and run nowhere by default |
| `packages/pi-browser` | Synced snapshot of the agentrun harness's `packages/pi-browser`: never edit it here. Real-Chrome suites run only in the `real-chrome` CI job (`npm run test:chrome -w @parcha/pi-browser`) |
| `packages/pi-vision` | ffmpeg/poppler suites run only in the `vision-binaries` CI job; `pi-1-2` and `pi-vision-pi-floor` cover its peer range |
| `packages/pi-transport` | Vitest on source; its biome `lint` and Docker suite (`test:live:docker`) run in the `transport-docker` CI job |
| `packages/pi-durable-agent` | Agent home; subpaths `./timeline`, `./export`, `./workflow`, `./serve`; bin `pi-durable-agent`. Only `./workflow` loads `dsl` and `pi`, lazily |
| `packages/serve` | Held. v2 API on `127.0.0.1:7340/v2`; each run is a `pi-durable-disk run` child; `--faux` needs no key and its tests use it |
| `packages/pi-git-remote` | No repository hook, filter or driver ever runs; https credentials reach git only on fd 3. Tests need git 2.40+ and `openssl` |
| `packages/pi-agent-learn` | Learning agent on `pi-git-remote`; locks `agent.json` and `AGENTS.md`, so `examples/agent-learn/agent/AGENTS.md` is runtime content. Tests need git 2.40+ |
| `packages/learn` | Held. `SPEC.md` is the learning-repository contract; `agentrun-learn check` reads git with plumbing only. Depends on `dsl` alone |
| `packages/decisions` | Held. Third-party decision models as `DecisionProvider`s (the seam and its conformance suite, `./testing`, are in `dsl`): `parallelProvider` for Parallel Decisions, key `PARALLEL_API_KEY` by name. A paid request is never re-sent unasked; a failure after sending is `outcome_unknown` and escalates as an interrupted decision. Tests use a fake fetch; `test/parallel.live.test.mjs` runs only with the key. Depends on `dsl` alone |
| `packages/harness` | Held. The reference host; `pi-transport` is an optional peer. Covered by `examples/reference*.test.mjs` |
| `packages/run-adapters`, `run-adapters-claude-agent`, `run-adapters-codex` | Held. Host-neutral (`scripts/check-package-imports.mjs`). Code from vercel-labs/durable-harness is tracked in `vendor/durable-harness/UPSTREAM.json`; never hand-edit `vendor/durable-harness/upstream/`. `scripts/port-durable-harness.mjs` regenerates the copies from those pristine files, the named patches and the import table under `vendor/durable-harness/port/`; `npm run verify:port` (`--check`) fails on any byte it does not make. The Claude adapter pins an exact SDK/CLI pair, the Codex adapter Codex 0.164.0 (its key-holding proxy forwards only `POST /v1/responses`); their real-binary `test/tool-off.test.mjs` skips locally without the binary, and CI sets `AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1` and `AGENTRUN_CODEX_REQUIRE_BINARY=1` so it fails instead |
| `apps/viewer` | Run viewer; `npm run test:viewer` (in `npm run check`) |
| `spec/lean`, `spec/receipts` | Lean model plus conformance corpus; TLA+ models `Receipts.tla` and `Door.tla` (see Models of recovery) |
| `examples/` | Offline (`npm run test:examples`, `*-live.test.mjs` included); runs with real keys are opt-in. Index: `docs/examples.md` |
| `changes/`, `docs/`, `scripts/` | Changelog fragments; guides (`guide.md`, `authoring.md`, `host-integration.md`, `releasing.md`); generation and verification scripts |

Seventeen packages share one version. `"private": true` holds `harness`, `serve`, `learn`, `decisions`,
`run-adapters`, `run-adapters-claude-agent` and `run-adapters-codex`: built, tested, verified and versioned like the
rest, never published; removing the flag lifts a hold. Release order: `scripts/release-preflight.mjs`.

## Setup and checks

Use Node 22.19+ or 24.2+ (`.nvmrc` pins 22.23.2, the release toolchain) and npm 11 (CI pins 11.21.0).
`scripts/check-node.mjs` refuses Node 23 and 24.0-24.1, which have no `import.meta.main`.
Regenerate `package-lock.json` only with npm 11 (`npm install --package-lock-only`), never by hand,
then `npm run export:source` and commit `docs/dependencies.md`: CI's `check-generated.mjs` fails on
a stale one and `npm run check` does not catch it.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check   # build, generated-file checks, typecheck, all tests, examples, viewer
npm run verify:packages   # packs each package into a clean consumer (install needs network; CI checks shard)
```

- Most package suites import `dist/`, so rebuild before running one file with `node --test`.
  Exceptions: `pi-durable-disk` runs on `src/*.ts`, `pi-transport` runs Vitest on source.
- Tests use scripted adapters and need no credentials or network. Live examples are opt-in.
- After changing workflow types: `npm run build`, then `node scripts/generate-schema.mjs`,
  `node scripts/generate-author-contract.mjs` (reads `packages/dsl/dist/`) and
  `node scripts/generate-author-references.mjs`; `npm run check` fails on any stale output.
- Fragments are validated by `node scripts/changes.mjs --check --base origin/main` (CI step 1),
  which also fails any edit of an `Unreleased` section.
- Packaging changes: `npm run export:source` and `npm run verify:source`.

## The host boundary

The engine is policy-agnostic. It reaches the outside world only through three adapters:

- `runNode` runs generative nodes (`agent`, `decide`, `extract`, `report`, and `markdown` or
  `report` artifacts) in the host's agent. A file `artifact` only names a file an earlier shell call
  produced.
- `runJudge` answers typed questions (`judge`, `pick`, `sift`, `route`, `ask`, `verify`).
- `runEffect` performs `call` nodes (tool, executor, shell).

Provider configuration, SOP text, budgets and application policy stay in the host or in the workflow
document that travels with the task, never in the interpreter. Node `metadata` belongs to the host;
the engine never reads it.

## Jev

Jev (TypeSafe System One) returns typed answers with probabilities: a boolean's yes-probability, a
choice with confidence, or a leveled score. It writes no prose and calls no tools. Use it for one
focused semantic decision per property: select evidence, compare a claim to its source, choose a
route. Code does exact work (lookups, arithmetic, joins); agents do open-ended research. Give Jev
the original source text, not an agent's paraphrase. Thresholds live in the workflow (`gte`,
`route.unsure`, or a code gate on `<as>$answers`), and uncertainty escalates or takes an explicit
fallback. Live calls need `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` with `provider:
"openrouter"`); tests never do.

## Lean

`spec/lean` is a contributor tool, not a runtime dependency. It proves properties of a model of the
interpreter, and the cases in `spec/lean/conformance/*.json` check that the model and TypeScript
agree on them. When validation, state paths, branch merges, loops or desugaring change:

1. Add a TypeScript regression test whose expected result was chosen independently of the
   implementation.
2. Update the Lean definitions or proofs if the model or its assumptions changed, and add a
   conformance case.
3. Run the Lean checks in [CONTRIBUTING.md](CONTRIBUTING.md#changing-workflow-behavior) (`lake
   build`, `lake exe conformance`, the validator sweep).

CI runs Lean separately from `npm run check`. Documentation-only changes don't need Lean.

## Models of recovery

`spec/receipts/Receipts.tla` (TLA+, checked by TLC with guard mutants) and
`spec/lean/AgentRunRecovery/Frozen.lean` (Lean) state what a recovery driver does with effects
across crashes, failed commits and the host's cancel (admit before dispatch, one dispatch per
effect, never resume a cancelled run). `spec/receipts/Door.tla` models the serve door's journal.

**A change to modeled behavior changes the model in the same pull request.** When a change touches
what a model states (the recovery hooks in `workflow.ts`, the `RecoveryStore` contract, a driver
over it, or the door in `packages/pi-durable-disk/src/door.ts`), update the TLA+ model and its
mutants (plus `Frozen.lean` for a driver; the door is `Door.tla` only) and run the checks in
[CONTRIBUTING.md](CONTRIBUTING.md#changing-recovery-behavior) (Java 11+ and `TLA2TOOLS` set to
`tla2tools.jar`; `lake build` runs in `spec/lean`), or say in the pull request why the model does
not move. A property that breaks is fixed in code or recorded with a test that reproduces its
counterexample, never deleted.

## Rules

- For a behavior change, add a test that fails before the change and asserts what the caller depends
  on. Mock at adapter boundaries.
- Keep semantic judgment in the model and execution invariants in code. Structural checks (shape,
  schema, reachability, state paths) belong in the validator; meaning belongs in a typed question. A
  heuristic patched a second time for new phrasing should become a question.
- Change one falsifiable thing at a time. A passing unit test or a model verdict does not prove a
  host integration works.
- Make failures observable: keep evidence, provenance, limits and cancellation. Never rerun an
  uncertain effect blindly.
- Never edit a fixture, check or threshold just to make a changed implementation pass, and never let
  a candidate rewrite its own verifier.
- A generative node carries the whole rubric it applies: `sopSection` lists every SOP section the
  decision depends on, and merged nodes inherit the union. Don't paraphrase policy into
  `instructions`.
- Extend the existing node, adapter and lifecycle interfaces before adding a mechanism. Delete
  superseded machinery only after its replacement passes.
- Document breaking changes and failure behavior in a fragment, `changes/<slug>.md` (see
  [changes/README.md](changes/README.md)); the release folds fragments into the changelogs. Never
  edit an `Unreleased` section of a `CHANGELOG.md`.
- Before a pull request goes to the maintainer, its author runs the ship-pr skill
  (`.agents/skills/ship-pr/SKILL.md`): one gate for every package, from a fresh base to CI and
  review threads.
- This repository is public. Keep machine paths, internal hostnames, credentials and customer data
  out of code, tests, commits and issues. `npm run export:source` rejects many of these.
- Never publish from a local machine. Releases go through the reviewed workflow in
  [docs/releasing.md](docs/releasing.md).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md), never in a public issue.
