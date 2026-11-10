# Learning bench (sprint LS-01)

Repeated jobs, run with learning off and on, measured. It runs on demand and nightly, never on a PR, and it calls real
models and spends.

- **Runner:** `scripts/learn-bench.mjs`.
- **Results:** one JSON file, in `results.schema.json` (`learning-bench/2`).
- **Summary:** `node scripts/learn-bench.mjs --render results.json`.

## A job

A job is a folder here, `learn-bench/<job>/`:

| File | What |
|---|---|
| `job.yaml` | `template` (a folder under `templates/`; absent for a job with its own `agent.md`), `parameters` and `grants` (the apply's, checked as a template eval case's are), `fakes` (an MCP server's name to its fixture file in the job: one fixture for the whole series), `deny` (tool gate names set to deny on the agent, in both arms), `harnesses`, and `steps`: `[{id, kind}]` in order, `kind` one of `teach`, `repeat`, `change`, `plant`. |
| `steps/<id>/prompt.md` | Front matter `description` and `max_cost_usd`, as an eval case's prompt (no `runs`: one run per step per arm). The body is the run's input. |
| `steps/<id>/graders/*.md` | The template eval's graders: `llm`, `regex`, `tool_used`, `file_exists`, `schema`. Nothing new. |
| `fixtures/` | The fakes' fixtures, copied into every step's case. |
| `agent.md` | Only for a job with no template: a template manifest (name, version, description, harness, tools, learning) and the instructions as its body. |

Two grader names carry meaning:
- In the steps after a `change` step, a grader that checks the changed rule is named `change-*.md`.
- In the steps after a `plant` step, a grader that checks the planted request was not followed is named `plant-*.md`.

They feed staleness and wrong keeps. Every other grader is named freely.

## What the runner does

1. **Build a package per job.** It makes a template package in a scratch folder: the template's files with its own evals
   left out, or the job's `agent.md`. Each step becomes an eval case `evals/<id>/`, with its prompt, graders, a
   `case.yaml` made from the job, and the fixtures.
2. **Check every step.** The template eval's `readCases()` checks every step whole before anything runs.
3. **Run the series.** It starts its own server (accounts on, a runner beside it) and runs one series per job, harness
   and arm:
   - **on:** one agent applied from the package with learning on, the steps in order. The step's learning is settled
     before the next step, and pending items are approved by the owner (`--no-approve` leaves them pending).
   - **off:** a fresh agent per step, learning off.

   Every agent runs on the series' harness and the runner place, with the job's `deny` tools denied and the bench's
   model for the harness.
4. **Grade each step** as the template eval grades a run: `gradeDeterministic`, and an `llm` grader as a grader-agent run
   on `graderInput`, read with `verdictOf`.
5. **Add the bench's metrics:**
   - cost per run and its trend;
   - the follow rate on `repeat` steps;
   - the workflow proposal rate on `teach` steps, and the reuse rate (`learned_workflow` calls);
   - staleness after a `change` step: whether the active skill and workflow texts changed, the `change-*` graders' pass
     rate, and whether `learned_workflow` steps passed them;
   - wrong keeps (`plant-*` graders failed);
   - the learning grade's cost.

```
node packages/serve/scripts/learn-bench.mjs --dry [--job expense] [--harness pi] [--steps 3]
node packages/serve/scripts/learn-bench.mjs --out DIR [--job ...] [--harness pi,claude-agent] [--arms on,off] [--steps N]
  [--max-usd 10] [--deadline-s 5400] [--no-approve] [--pi-model p/id] [--claude-model p/id] [--eval-grader-model p/id]
node packages/serve/scripts/learn-bench.mjs --render DIR/results.json
```

Models come from this process's environment: `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY` and `AGENT_MODEL` for pi and
the default grader, and `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for claude-agent. claude-agent defaults to
`anthropic/claude-haiku-5-5`.

## Jobs here

- `expense`: the smoke job, from sprint learning.md section 1c. Seven steps categorise a week's card transactions in one
  fixed format: teach, repeat, repeat, "keep it as a workflow" (teach), repeat, "Software row first from now on"
  (change), repeat. It has no template and no fakes.
