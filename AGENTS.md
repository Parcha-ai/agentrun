# Agent instructions

Guidance for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the authority where the two differ. To add AgentRun to another project, use [docs/agent-instructions.md](docs/agent-instructions.md) instead.

## What this is

AgentRun is a workflow language for agents a host already runs. A workflow is a JSON document (or TypeScript builder output) of typed nodes. The interpreter executes it and calls back into the host for every model call and side effect. The host keeps its tools, models, permissions, budgets and delivery. The DSL fixes the steps, state contracts, bounded control flow and escalation points, so a repeatable procedure can be inspected, rerun, tested with fixtures and offered to an agent as one tool.

## Layout

| Path | What |
| --- | --- |
| `packages/dsl` | `@parcha/agentrun-dsl`: types, `validateWorkflow`, `runWorkflow`, dry run, inspection, CLI (`agentrun`) |
| `packages/dsl/src/workflow.ts` | The interpreter: node execution, state paths, parallel merge, desugaring |
| `packages/dsl/skills/author/` | Packaged authoring skill. `references/language.md` is the full node reference; `references/jev-decisions.md` covers judgment design |
| `packages/dsl/schema/workflow.schema.json` | Generated editor schema |
| `packages/jev` | `@parcha/agentrun-jev`: `createJevRunner()`, the `runJudge` adapter for Jev |
| `packages/pi` | `@parcha/agentrun-pi`: the Pi extension (`/agentrun`) and Pi-backed `runNode` runner |
| `packages/pi-durable-disk` | `@parcha/pi-durable-disk`: a durable pi host on a network disk, Archil in this release (claim, fence, lease, supervisor). It does not depend on the other packages. Its live suites (`PDA_LIVE=1`) need an Archil account and are not part of `npm test` or CI |
| `packages/pi-browser` | `@parcha/pi-browser`: a browser for pi agents (session custody, evidence, typed failures; the pi coding agent's extension, a pi-durable adapter, Browserbase and local-Chrome providers, a fake backend in `./testing`). It does not depend on the other packages. It is a synced snapshot of the agentrun harness's `packages/pi-browser`: do not edit it here, the change goes to the harness and comes back through the sync. Its real-Chrome suites run in the `real-chrome` CI job (`npm run test:chrome -w @parcha/pi-browser`), not in `npm test` |
| `packages/pi-vision` | `@parcha/pi-vision`: eyes for pi agents (documents, images, scans and video read within the model's limits, typed misses, a receipt with SHA-256 and price for every look; a host-neutral core, a pi-durable adapter, providers, fake eyes and a provider conformance suite in `./testing`). It does not depend on the other packages. Its suites that run ffmpeg and poppler live in `test/binaries` and run in the `vision-binaries` CI job (`npm run test:binaries -w @parcha/pi-vision`), not in `npm test`; its peers accept pi-durable and chord from 1.0.4 to 1.3.x and pi-ai at any version, so the `pi-1-2` job runs its suite on pi 1.2.0 and 1.3.0, and the `pi-vision-pi-floor` job runs it through `scripts/pi-leg.mjs` with pi-durable, chord and pi-ai at 1.0.4, the lowest its peers accept |
| `packages/pi-transport` | `@parcha/pi-transport`: a `Box` interface with providers for this machine and Docker, a strict transport config, and a box conformance suite in `./testing`. It does not depend on the other packages. Its tests run with Vitest on source (`npm test -w @parcha/pi-transport`), and its Docker suite is opt-in (`npm run test:live:docker -w @parcha/pi-transport`) |
| `packages/pi-durable-agent` | `@parcha/pi-durable-agent`: an agent home, one directory of pi-durable stores that keeps an agent's definition, skills, browser sign-ins and runs index (`createAgentHome`, `startRun`, `durableProfileStore`, `carryBack`), the one packer that moves a home as a tar (`packHome`, `readPack`, `importPack`), its `./timeline` subpath, one human-readable timeline of a run (`timelineOf`, `timelineReducer`, `groupTimeline`, `renderText`), and its `./export` subpath, the export lists with no import (`EXPORTABLE_KINDS`, `SECRET_KINDS`, `projectForExport`). It does not depend on the other packages. It is held (`"private": true` in its manifest). Its tests run with `node --test` on `dist/` (`npm test -w @parcha/pi-durable-agent`) |
| `packages/serve` | `@parcha/agentrun-serve`: the Agentrun v2 API (`agentrun.v2/0`) on this machine, over agent homes in a data directory, on `http://127.0.0.1:7340/v2` with a bearer token. Each run is a child process of `pi-durable-disk run` with the package's own app; a faux model module (`--faux`) runs it with no key. It is held (`"private": true` in its manifest). Its tests run with `node --test` on `dist/` (`npm test -w @parcha/agentrun-serve`) and start real run processes on the faux model |
| `packages/pi-git-remote` | `@parcha/pi-git-remote`: a git repository a host keeps for its agent (`openRepo`; the remotes `local`, `https` and `codeStorage`; `commitTo` through plumbing, idempotent by a `Run-Id` trailer, `push` by sha, `merge`, `revert`, `checkout`), and its `./coding-agent` subpath, a pi coding-agent extension (`createGitRemoteExtension`) that checks a ref out for a session and commits the allowlisted changes to `sessions/{sessionId}` when it ends. No hook, filter or driver of either repository runs, and an https credential reaches git only on fd 3. It does not depend on the other packages; its `@earendil-works/pi-coding-agent` peer is optional at `*`, pi 1.1.0 is its dev dependency, and the `pi-1-2` job runs its type-check and suite on pi 1.2.0 and 1.3.0. It is held (`"private": true` in its manifest). Its tests run with `node --test` on `dist/` (`npm test -w @parcha/pi-git-remote`) and need git 2.40 or later and `openssl`; `test/https.test.mjs` runs a TLS smart-HTTP server on 127.0.0.1 over `git http-backend` and answers only git's own requests; `test/hostile/` is a hostile-repository corpus with its own control under plain git |
| `packages/pi-agent-learn` | `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of `@parcha/pi-git-remote` (`agentLearn`, the pi-durable extension with the `learn` tool and the `<learned>` section; `seedLearning`, the host step that seeds a run from a commit; `guard`, the structural check every writer runs, and `proposeLearning`, the host step that commits a run's candidates to `runs/<run id>` once the guard passes them; the repository layout, with `agent.json` and `AGENTS.md` locked against every writer). Its pi-durable and chord peers accept 1.1 to 1.3.x, so the `pi-1-2` job runs its suite on pi 1.2.0 and 1.3.0. It is held (`"private": true` in its manifest). Its tests run with `node --test` on `dist/` (`npm test -w @parcha/pi-agent-learn`) and need git 2.40 or later |
| `packages/reference` | `@parcha/agentrun-reference`: the reference host as a package, so an example runs from an npm install: `run`, `demo` (the supervisor that kills and resumes a run's process anywhere), `localHost`, `placeAt`, the recorder and `codeOf`, with `./scan` (the one credential and machine-path scanner), `./child-app` (the app module for `pi-durable-disk run --app`) and `./place`. `@parcha/pi-transport` is an optional peer, needed only by a demo that declares `boxes`. Its example job is `examples/reference/` |
| `spec/lean` | Optional Lean model of validation and execution, plus a conformance corpus shared with TypeScript, and a Lean model of a recovery driver's effects (`AgentRunRecovery/`) |
| `spec/receipts` | TLA+ model of a recovery driver's effects across crashes and failed commits, with its TLC configs; `scripts/spec/` checks it and its guard mutants |
| `examples/` | Support, typed research and starter app, offline by default with scripted adapters |
| `changes/` | One changelog fragment per pull request, folded into the changelogs by the release |
| `docs/` | `guide.md` (primitives, limits), `authoring.md`, `host-integration.md`, `releasing.md` |
| `scripts/` | Node floor, schema and contract generation, source export, package and release verification |

The twelve packages share one version. `dsl`, `jev` and `pi` are published in that order, then `pi-durable-disk`, `pi-browser`, `pi-vision` and `pi-transport`, then `reference`, which depends on them. `pi-durable-agent`, `serve`, `pi-git-remote` and `pi-agent-learn` are held (`"private": true` in their manifests) while publishing them is on hold: each is built, tested, verified and kept at the workspace version like the others, and is in no publish path. Removing that one flag lifts a hold.

## Setup and checks

Use Node 22.19+ (`.nvmrc`; release verification uses 22.23.2) and npm.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check   # build, generated-file checks, typecheck, all tests
```

Tests import from `dist/`, so rebuild before running a single file with `node --test`. Tests use scripted adapters and need no credentials or network. Live examples are opt-in. After changing workflow types, run `node scripts/generate-schema.mjs` and `node scripts/generate-author-contract.mjs`. For packaging changes, run `npm run export:source` and `npm run verify:source`.

## The host boundary

The engine is policy-agnostic. It reaches the outside world only through three adapters:

- `runNode` runs generative nodes (`agent`, `decide`, `extract`, `report`, and `markdown` or `report` artifacts) in the host's agent. A file `artifact` only names a file an earlier shell call produced.
- `runJudge` answers typed questions (`judge`, `pick`, `sift`, `route`, `ask`, `verify`).
- `runEffect` performs `call` nodes (tool, executor, shell).

Provider configuration, SOP text, budgets and application policy stay in the host or in the workflow document that travels with the task, never in the interpreter. Node `metadata` belongs to the host; the engine never reads it.

## Jev

Jev (TypeSafe System One) returns typed answers with probabilities: a boolean's yes-probability, a choice with confidence, or a leveled score. It writes no prose and calls no tools. Use it for one focused semantic decision per property: select evidence, compare a claim to its source, choose a route. Code does exact work (lookups, arithmetic, joins); agents do open-ended research. Give Jev the original source text, not an agent's paraphrase. Thresholds live in the workflow (`gte`, `route.unsure`, or a code gate on `<as>$answers`), and uncertainty escalates or takes an explicit fallback. Live calls need `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` with `provider: "openrouter"`); tests never do.

## Lean

`spec/lean` is a contributor tool, not a runtime dependency. It proves properties of a model of the interpreter, and the cases in `spec/lean/conformance/*.json` check that the model and TypeScript agree on them. When validation, state paths, branch merges, loops or desugaring change:

1. Add a TypeScript regression test whose expected result was chosen independently of the implementation.
2. Update the Lean definitions or proofs if the model or its assumptions changed, and add a conformance case.
3. Run the Lean checks in [CONTRIBUTING.md](CONTRIBUTING.md#changing-workflow-behavior) (`lake build`, `lake exe conformance`, the validator sweep).

CI runs Lean separately from `npm run check`. Documentation-only changes don't need Lean.

## Models of recovery

`spec/receipts/Receipts.tla` (TLA+, checked by TLC with guard mutants) and `spec/lean/AgentRunRecovery/Frozen.lean` (Lean) state what a recovery driver does with effects across crashes and failed commits: admit before dispatch, one dispatch per effect, a resume that answers a completed effect and refuses an unknown one, nothing admitted after a failed commit.

**A change to modeled behavior changes the model in the same pull request.** When a change touches what either model states (the recovery hooks in `workflow.ts`, the `RecoveryStore` contract, or a driver over it), update `Receipts.tla`, its mutants and `Frozen.lean` together, run `scripts/spec/check-receipts.sh`, `node scripts/spec/receipts-mutants.mjs` and `lake build`, or say in the pull request why the model does not move. A property that breaks is fixed in code or recorded with a test that reproduces its counterexample, never deleted.

## Rules

- For a behavior change, add a test that fails before the change and asserts what the caller depends on. Mock at adapter boundaries.
- Keep semantic judgment in the model and execution invariants in code. Structural checks (shape, schema, reachability, state paths) belong in the validator; meaning belongs in a typed question. A heuristic patched a second time for new phrasing should become a question.
- Change one falsifiable thing at a time. A passing unit test or a model verdict does not prove a host integration works.
- Make failures observable: keep evidence, provenance, limits and cancellation. Never rerun an uncertain effect blindly.
- Never edit a fixture, check or threshold just to make a changed implementation pass, and never let a candidate rewrite its own verifier.
- A generative node carries the whole rubric it applies: `sopSection` lists every SOP section the decision depends on, and merged nodes inherit the union. Don't paraphrase policy into `instructions`.
- Extend the existing node, adapter and lifecycle interfaces before adding a mechanism. Delete superseded machinery only after its replacement passes.
- Document breaking changes and failure behavior in a fragment, `changes/<slug>.md` (see [changes/README.md](changes/README.md)); the release folds fragments into the changelogs. Never edit an `Unreleased` section of a `CHANGELOG.md`.
- Before a pull request goes to the maintainer, its author runs the ship-pr skill (`.agents/skills/ship-pr/SKILL.md`): one gate for every package, from a fresh base to CI and review threads.
- This repository is public. Keep machine paths, internal hostnames, credentials and customer data out of code, tests, commits and issues. `npm run export:source` rejects many of these.
- Never publish from a local machine. Releases go through the reviewed workflow in [docs/releasing.md](docs/releasing.md).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md), never in a public issue.
