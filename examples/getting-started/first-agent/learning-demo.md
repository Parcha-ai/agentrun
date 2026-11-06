# Your first agent, and watching it learn

Two runs. The first does real work in the agent's box and states a rule on the side. The second is a different task
with no hint, and the agent follows the rule. These prompts went 9 of 9 on Claude Code, pi and Codex on the published
`0.1.0-beta.31`, and again on an OpenRouter key alone.

You need AgentRun running with Docker and one model key ([what you need](../README.md)), and the owner password set
in the console. Run 1 uses `pip` in the box and run 2 reaches PyPI from it, so both need the box: without Docker, pick
a task that needs no shell.

## 1. Make the agent

[engineer.json](engineer.json) is a Claude Code agent with learning on. It names no `tools` and no `place`, so it
gets a shell in a Docker box of its own. From this folder:

```sh
npx -y @parcha/agentrun agents create --body @engineer.json
npx -y @parcha/agentrun agents list
```

The CLI finds the server started with the same `--data` and its token on its own. For another server, set
`AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`. `agents list` shows every agent's id: this one is `engineer`, and an agent
made in the console gets a UUID, which the run commands take in its place.

Or make it in the console: New agent, harness Claude, leave the model and the place at their defaults (it lands in a
sandbox with `bash` ticked), Learning on, and the instructions from `engineer.json`.

## 2. Run 1 teaches a rule

```text
Install the Python package httpx in your box and tell me its version.
Rule for every report you write from now on: start with "STATUS: OK" or "STATUS: FAIL", keep it to five lines or fewer, and end with a line that starts with "Next:" and names one action.
```

```sh
npx -y @parcha/agentrun runs start engineer --body '{"input":{"content":"Install the Python package httpx in your box and tell me its version.\nRule for every report you write from now on: start with \"STATUS: OK\" or \"STATUS: FAIL\", keep it to five lines or fewer, and end with a line that starts with \"Next:\" and names one action."},"max_cost_usd":1}'
npx -y @parcha/agentrun runs get <run_id>
```

Call `runs get` every few seconds until `status` is `completed`. The answer is `result.final_answer`: the timeline
shows `pip install httpx`, and the report comes in the new format, 15 to 20 seconds in. It may add a line such as
"I'll keep your report-format rule for later runs"; run 2 is the one that shows it learned. Within about 10 seconds
of the end, `learning.state` reads `merged`.

The run's page is `http://localhost:<port>/#/runs/<run_id>` (the API doesn't return that link yet). It shows a
learning chip naming what it kept.

## 3. The Learning tab

Open the agent's Learning tab in the console. The note about the report format is under "What it has learned",
marked "Learned in" run 1. "What the next run reads" lists it as active; that section is collapsed, click it open.

A note under "Waiting for your OK" is one the grader held back: press Approve as the signed-in owner. `learning.state`
reading `dropped` means the grader kept nothing; the run's page says why. State the rule more plainly and run step 2
again.

## 4. Run 2 follows it, with no hint

```text
Check that https://pypi.org/simple/ answers from your box: tell me its HTTP status code.
```

```sh
npx -y @parcha/agentrun runs start engineer --body '{"input":{"content":"Check that https://pypi.org/simple/ answers from your box: tell me its HTTP status code."},"max_cost_usd":1}'
npx -y @parcha/agentrun runs get <run_id>
```

The answer starts with `STATUS: OK`, is five lines or fewer, and ends with a `Next:` line, though nobody asked for
it. The `Next:` line often reads "No action needed". This run's `learning.state` reads `dropped`, with "Nothing new to
remember": the rule is already kept. About $0.03 for the pair on OpenRouter.

If the answer mentions `127.0.0.1`, that is the sandbox doing its job: the box reaches the internet only through
AgentRun's egress proxy, which allows a short list of hosts (PyPI, npm, GitHub), so a connection's remote address can
read as local.

## A second agent, with web tools

[due-diligence.json](due-diligence.json) is a Claude Code agent with `web_search` and `web_fetch`, learning on, and a
skill that says how to write a brief. `web_search` needs no key. The same two beats:

```sh
npx -y @parcha/agentrun agents create --body @due-diligence.json
npx -y @parcha/agentrun runs start due-diligence --body '{"input":{"content":"Research https://stripe.com and write the due-diligence brief. Team rule for every due-diligence brief you write for us from now on: end every brief with a line '"'"'Risk: low'"'"', '"'"'Risk: medium'"'"' or '"'"'Risk: high'"'"', followed by a numbered source list."},"max_cost_usd":1}'
npx -y @parcha/agentrun runs start due-diligence --body '{"input":{"content":"Research https://www.gusto.com and write the due-diligence brief."},"max_cost_usd":1}'
```

The first brief ends with `Risk: low` and a numbered source list. So does the second, with no hint in its input, and
the Learning tab shows "Due-diligence brief format rule", learned in the first run. A site whose pages refuse a plain
fetch (Gusto's About page answers 403) makes the brief say so and lean on search results; pick a site that serves
plain fetches, or save a Parallel key under Settings → Tool keys and pick Parallel for `web_fetch`.

## Let your coding agent drive it

The same from Claude Code or Codex, with the CLI:

```text
Using the AgentRun CLI (`npx -y @parcha/agentrun agents list` to find the agent named "Engineer" and its agent_id, then `... runs start <that agent_id> --body '{"input":{"content":"..."}}'` and `... runs get <run id>`), start a run of that agent that checks whether `requests` installs in its box, wait for it, and tell me its answer verbatim.
```

The answer follows the learned format again. Over MCP instead: [docs/SKILL.md](../../../docs/SKILL.md#drive-it-from-your-own-session).
