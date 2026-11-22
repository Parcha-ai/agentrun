# Teach an expensive agent, run a cheap one

A strong model figures the job out and writes it down as a workflow. A cheap model runs the workflow. The strong model
only sees the hard cases. It's how we took [merchant codes from $0.89 to $0.12](../case-studies/merchant-classification.md).

## 1. Pick two models

The agent runs on the strong one. Workflow steps on the `fast` tier run on the cheap one.

```sh
AGENT_MODEL=openrouter/anthropic/claude-opus-5.5 \
AGENT_MODEL_FAST=openrouter/openai/gpt-6-luna \
npx @parcha/agentrun
```

## 2. Make the agent

```sh
cat > agent.json <<'EOF'
{"definition": {"id": "mcc", "version": 1, "name": "Merchant codes",
  "instructions": "Given a merchant's name and website, find the exact 4-digit MCC, with the URL and the quote that decided it. Before you finish, use ask_person to show your answer and ask if it's right. In a workflow you write, put judgment steps on the fast tier.",
  "skills": [], "tools": ["web_search", "web_fetch", "ask_person"], "learning": true}}
EOF
npx @parcha/agentrun agents create --body @agent.json
```

The last sentence of the instructions is what makes its workflows run cheap. The one before it is how you teach it.

## 3. Tell it how it did

Start a run on a real input. It stops before it finishes and asks you to check its answer (`--wait` exits 8 while it
waits on you):

```sh
npx @parcha/agentrun runs start mcc --wait \
  --body '{"input": {"content": "Merchant: Blue Fern Boutique, https://bluefern.example"}}' > out.json
run=$(node -p 'require("./out.json").run_id')
```

Answer it:

```sh
npx @parcha/agentrun runs message "$run" --content "Right answer: 5691. You said 5651. The site only sells women's clothing."
```

Then the run finishes, and your words go into the agent's `corrections.md` as one line. Every later run is given that
file whole before it starts. Cover every field you care about: the one you never mention is the one it gets sloppy on.

## 4. Watch it learn

Open the agent's **Learning** tab. Your corrections show up first, one line each. Once the agent has 20 completed runs
(`learning: { "compile_after": 20 }` is the default), one run's end compiles the job into a workflow, which is checked
once on those runs' inputs before it serves. From then on every run reaches for the workflow first.

## 5. Check the bill

Every run shows its cost, learning included. Ours dropped the run the workflow took over and stayed there.

The Learning tab's **Cost per run** chart draws it run after run: each run's all-in cost as a dot coloured by the path
it took (the agent by hand, a learned workflow that handed back, or the workflow alone), a rolling mean through them,
the agent's cost before learning as a dashed line, a marker at the first run the workflow finished alone, and the
level after it. Once 20 runs stand behind that level, it says how many times cheaper it is.

![The cost per run chart: about $0.89 a run by hand, a marker where the learned workflow took over at run 21, then about $0.13 a run, 7.0x cheaper (marked Example data); under it, who finished each run, a column a run coloured by its path, the learned workflow's from run 21](../assets/tutorials/cost-per-run.png)

The chart above is an invented agent's runs. `agentrun learning cost <agent> --format csv` writes your agent's series as
CSV, to plot or check yourself (`GET /v2/agents/{id}/learning/cost` answers it as JSON).

Under the chart, **who finished each run** colours each run by its path on the same run axis (a column a run where the
chart has room for one each, else each block of runs stacked by path), so the learned workflow's share grows from the
takeover marker.

Above both, the tab opens on one sentence and four figures: the cost ratio, how often the serving revision's answer was
the agent's on its promotion check, how many of the runs it ran first it finished alone, and the bill's break-even run.
Each share has its count and its 95% interval. **Cost against agreement** draws each promoted revision as a point: what
a run it served cost against how often it agreed with the agent on its check's inputs, with its audits since as a
hollow mark beside it. Agreement is not accuracy: the agent's answer is the reference.

To prove it, keep some inputs it never learns on and compare learning off and on. The
[learning bench](../../packages/serve/learn-bench/README.md) does that for you.
