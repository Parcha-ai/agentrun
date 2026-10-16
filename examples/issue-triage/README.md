# The issue-triage demo

An agent drafts a workflow that triages a public repository's twenty newest open issues, and the run is one durable task. For each issue, a research step (an agent with read-only tools) reads the issue, the pull requests that mention it and the code it names; Jev chooses one of five labels; Jev judges whether it is a good first issue against a stated rubric; the result is a table and the agreement with the maintainers' own labels. A run killed partway finishes with no paid call repeated.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:issue-triage
```

It runs on scripted fakes: no key, no network, $0. The twenty issues are fictional, in the shape of the Express repository's, so no real person's text is in the recording. The flags are the reference entry's (`--record <dir>`, `--kill`, `--dir`, `--json`; see `examples/reference/README.md`).

| File | What |
|---|---|
| `workflow.json` | the reference workflow: a map over issue numbers; per issue `call` (issue), `call` (linked pull requests), `agent` (research), `judge` (label, a choice), `judge` (good first issue, a boolean), `code` (the row); then the agreement. It validates and dry-runs clean. |
| `AUTHOR-PROMPT.md` | what the user says to the drafting agent: describe, inspect, dry-run, save, learn, run |
| `fixtures.json`, `TRUTH.md` | the twenty fictional issues, the files they name, and the scripted answers (17 of 20 labels agree with the maintainers') |
| `job.ts`, `run.ts`, `demo.json` | the job and fakes, the entry call, and the spec |
| `SETUP-PROMPT.md` | what a stranger gives their coding agent to set the demo up |

## The five labels, as one Jev question

`LabelQuestion` is one choice question. The question is the property's description; each option carries its criterion.

| Label | Criterion |
|---|---|
| bug | The issue reports behaviour that contradicts the repository's own documentation or an earlier release, with a way to see it fail. |
| feature | The issue asks for behaviour the project does not have, or a change to an API on purpose; nothing is broken today. |
| docs | The issue is about wrong, missing or unclear documentation, a README or a guide; the code behaves as designed. |
| question | The reporter asks how to use the project, or why it works as it does; no change is asked for. |
| needs-info | What is reported cannot be acted on yet: no version, no way to reproduce, or no clear ask; the next step is a question back to the reporter. |

## The good-first-issue rubric, as one Jev question

`GoodFirstQuestion` is one boolean (noul) question: *is this a good first issue: could a newcomer to the project take it and finish it without a maintainer's design decision?*

- **Yes**: the change is small and local (one file or one function), the issue names where it is, the expected result is stated or checkable by a test, and a newcomer can do it without knowing the project's design.
- **No**: the change spans several modules, needs a design decision from a maintainer, depends on an unreleased change or an unclear ask, or needs knowledge of the project's internals.

The row's confidence is the distance of the yes-probability from one half, doubled. A threshold on it, if a host wants one, belongs in the workflow, not in the question.

## Choosing the repository for a live take

The repository needs at least twenty open issues carrying the maintainers' own labels, labels that map onto the five, an active history and a permissive license.

1. **`expressjs/express`** (MIT, pushed within the week of the check, 2026-10-16): 108 open issues, 37 of them carrying the maintainers' labels: `enhancement` 20, `awaiting more info` 10, `bug` 5, `docs` 1, `question` 1 (`require-triage` 4 more). All five labels map. The mix leans to `feature` and `needs-info`, which makes the agreement figure honest rather than easy; `docs` and `question` are thin, so a take needs the newest twenty to be chosen with at least one of each, or the full labelled set.
2. **`fastify/fastify`** (MIT, active): labels `bug`, `documentation`, `feature request`, `question`, `need info` all exist and map one to one, but only 17 open issues carry one today (13 feature requests, 4 docs), so it is short of twenty and has no open `bug`, `question` or `need info`.

The first is the pick unless a maintainer's labelling changes before the take; the counts are re-read the day of the take.

### Showing an issue's text in a published recording

An issue's title and body are third-party text written by a named person, and a recording is published. The live take publishes the issue's number, its URL, the two labels and the verdicts, and quotes at most 200 characters from a source (the evidence field already caps it), with the source named. It publishes no username, avatar or email, and it records no issue body past the cap. A run on the live repository is read-only (GitHub's read API; no comment, label or reaction is written). The scripted run above avoids the question: its issues are fictional.
