# The issue-triage demo

An agent drafts a workflow that triages a public repository's twenty newest open issues, and the run is one durable task. For each issue, a research step (an agent with read-only tools) reads the issue, the pull requests that mention it and the code it names; Jev gives it one of four types (bug, feature, docs, question); Jev judges whether it is a good first issue against a stated rubric and whether it is actionable as written; the result is a table and the agreement of Jev's type with the maintainers' own type labels. A run killed partway finishes with no paid call repeated.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:issue-triage
```

It runs on scripted fakes: no key, no network, $0. **The twenty issues are synthetic, written for the scripted run: they are not a real repository's issues** (they borrow the Express repository's type-label vocabulary and nothing else), so no real person's text is in the recording. The live takes use a real public repository's issues; see below. The flags are the reference entry's (`--record <dir>`, `--kill`, `--dir`, `--json`; see `examples/reference/README.md`).

| File | What |
|---|---|
| `workflow.json` | the reference workflow: a map over issue numbers; per issue `call` (issue), `call` (linked pull requests), `call` (code), `agent` (research), one `judge` that asks Jev three questions in a single request (the type, a choice; good first issue and actionable, booleans), `call` (the maintainers' labels), `code` (the row); then the agreement. It validates and dry-runs clean. |
| `AUTHOR-PROMPT.md` | what the user says to the drafting agent: describe, inspect, dry-run, save, learn, run |
| `fixtures.json`, `TRUTH.md` | the twenty fictional issues, the files they name, and the scripted answers (17 of 20 types agree with the maintainers') |
| `job.ts`, `run.ts`, `demo.json` | the job and fakes, the entry call, and the spec |
| `analyze.mjs` | what a killed take's stores show: Jev requests sent against answers recorded, tool calls, and the model turns asked and committed in each process |
| `live.ts`, `github.ts`, `pick-issues.mjs` | the live parts: the model and Jev's judge, the read-only GitHub tools, and the host's pick of the twenty issues |
| `SETUP-PROMPT.md` | what a stranger gives their coding agent to set the demo up |

## The four types, as one Jev question

The type is one choice question of the `triage` judge (`Judgment.label`). The question is the property's description; each option carries its criterion.

| Type | Criterion |
|---|---|
| bug | The issue reports behaviour that contradicts the repository's own documentation or an earlier release, with a way to see it fail. |
| feature | The issue asks for behaviour the project does not have, or a change to an API on purpose; nothing is broken today. |
| docs | The issue is about wrong, missing or unclear documentation, a README or a guide; the code behaves as designed. |
| question | The reporter asks how to use the project, or why it works as it does; no change is asked for. |

Only this type is scored against the maintainers' labels, and every Jev answer counts: a type that differs from the maintainers' is a miss, never dropped.

## Actionable, as one Jev question (shown, never scored)

`Judgment.actionable` is one boolean (noul) question of the same request: *can a maintainer act on this report as written: does it give enough to start work without asking the reporter anything first?* **Yes**: it states what is wrong or wanted and gives enough to start (a version or setup, a way to reproduce, or a clear ask). **No**: it is missing something a maintainer must ask for before starting (a version or setup, a way to reproduce, or what is wanted). It is a column on every row. It is not scored, because the maintainers' own label for it, where a repository has one (Express's `awaiting more info`), is a *process state* (we are waiting on the reporter), not a property of the report, and scoring one against the other would measure the label's use, not Jev.

## The good-first-issue rubric, as one Jev question

`Judgment.good_first_issue` is one boolean (noul) question of the same request: *is this a good first issue: could a newcomer to the project take it and finish it without a maintainer's design decision?*

- **Yes**: the change is small and local (one file or one function), the issue names where it is, the expected result is stated or checkable by a test, and a newcomer can do it without knowing the project's design.
- **No**: the change spans several modules, needs a design decision from a maintainer, depends on an unreleased change or an unclear ask, or needs knowledge of the project's internals.

The row's confidence is the distance of the yes-probability from one half, doubled. A threshold on it, if a host wants one, belongs in the workflow, not in the question.

## The maintainers' labels are the truth, and the classifier never sees them

The label an issue carries is what the run is scored against, so nothing the research agent or either Jev question reads may contain it. The workflow enforces that by structure, not by an instruction: `github_issue` hands over the issue's number, title, body and URL and no labels; the research agent and both judges are given explicit state maps built from that; and the maintainers' labels are fetched by their own call, `github_labels`, after both judgments, and used only by the last step to compute the row's agreement. A test (`examples/issue-triage.test.mjs`) holds a run to it: no state, instruction or question handed to the agent or a judge contains a maintainer's label.

## A live run

```sh
export GITHUB_TOKEN=...          # optional: a token with no scopes reads public repositories (60 requests an hour without one)
export TYPESAFE_API_KEY=...      # Jev's judge
export OPENAI_API_KEY=...        # the lead model (or DEMO_MODEL_BASE_URL for an OpenAI-compatible gateway)
node examples/issue-triage/pick-issues.mjs expressjs/express > input.json    # the 20 newest open issues that carry a maintainers' type label (stderr: the composition)
npm run demo:issue-triage -- --live --input input.json --max-usd 2.5 --record <dir>
```

The lead model is pi-ai's own catalog entry for `openai/gpt-6-luna` (its price included, so `--max-usd` meters real numbers) on `OPENAI_API_KEY`, or, with `DEMO_MODEL_BASE_URL`, with only its base URL pointed at an OpenAI-compatible gateway that holds its own credential; Jev's judge is `createJevRunner` on `TYPESAFE_API_KEY`. Every GitHub call is a read-only GET. `--kill` adds the kill at the tenth `triage` question.

## Choosing the repository for a live take

The repository needs at least twenty open issues carrying the maintainers' own type labels (bug, feature, docs, question), an active history and a permissive license. A waiting-on-reporter label is not a type and neither picks nor scores an issue.

1. **`expressjs/express`** (MIT, pushed within the week of the check, 2026-10-16): 108 open issues, 27 of them carrying a type label (`enhancement` 20, `bug` 5, `docs` 1, `question` 1; `awaiting more info` is a process state and not counted). The 20 newest of those are the live take's; their composition is printed with the pick and shown on the card, and it leans to `feature`, with `docs` and `question` thin.
2. **`fastify/fastify`** (MIT, active): `bug`, `documentation`, `feature request` and `question` exist, but only 17 open issues carry one today (13 feature requests, 4 docs), so it is short of twenty and has no open `bug` or `question`.

The first is the pick unless a maintainer's labelling changes before the take; the counts are re-read the day of the take.

### Showing an issue's text in a published recording

An issue's title and body are third-party text written by a named person, and a recording is published. A live recording **holds each issue's title and its body, up to 4,000 characters**, because the run reads them and the recorder keeps every tool answer; the research agent's cited quotations are schema-capped at 200 characters. It holds no username, avatar or email, and the run is read-only (GitHub's read API; no comment, label or reaction is written). Publishing a live take is therefore the owner's decision about that repository's public issue text. The scripted run avoids the question: its issues are synthetic.

### One request per issue

The three questions are asked in one Jev request per issue, not three: the entry caps a run at 50 judge requests and 40,000 tokens (Jev's limits), and twenty issues at three requests each would be 60. One request also sends the issue's text once. Jev answers each question of a request against the same state, independently.

### What a killed take claims, and what its store can show

A take killed once and resumed says: *Jev and tool calls repeated 0. No model turn was recorded twice; N agent turns in flight at the kill were completed by the resumed process, each recorded once.* The counts come from the recording's stores (the run's Jev request counter, the tool ledger, and each conversation's asked and committed model turns). They cannot show whether a model stream had been fully received before the kill, so the card does not say that.
