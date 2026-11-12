# Teach an expensive agent, run a cheap one

A strong model is great at figuring a job out. A cheap model is great at doing the same thing again. AgentRun lets you
use both: the strong model learns the job and writes it down as a workflow, and the workflow's steps run on the cheap
model. That's how [merchant classification went from $0.89 to $0.124 a merchant](../case-studies/merchant-classification.md).

It works for any job you do over and over with different inputs: classifying, checking a document against a list,
due diligence, triage.

## 1. Pick the two models

The agent runs on the strong model. A learned workflow's model steps run on the model of the tier they name, and the
`fast` tier is your cheap one:

```sh
AGENT_MODEL=openrouter/anthropic/claude-opus-5.5 \
AGENT_MODEL_FAST=openrouter/openai/gpt-6-luna \
npx @parcha/agentrun
```

## 2. Make the agent and turn learning on

Short instructions, the tools the job needs, and `"learning": true`:

```sh
cat > agent.json <<'EOF'
{"definition": {"id": "mcc", "version": 1, "name": "Merchant codes",
  "instructions": "Given a merchant's name and website, answer the exact 4-digit MCC, with the URL and the quote that decided it.",
  "skills": [], "tools": ["web_search", "web_fetch"], "learning": true}}
EOF
npx @parcha/agentrun agents create --body @agent.json
```

## 3. Run it, and be its reviewer

Run the job on real inputs. After each run, tell the agent how it did: the right answer next to its own, and why. Send
it as a follow-up on the same run:

```sh
npx @parcha/agentrun runs message "$run" --content "Reference: 5691 (clothing store). You answered 5651. The site sells only women's clothing."
```

At the end of every run the agent gets one more turn to say what it would keep, and it reads the whole conversation,
your feedback included. Send the same feedback whether it was right or wrong, and cover every field of the answer you
care about. A field nobody gives feedback on is the one the agent trades away.

## 4. Watch it write the workflow

Open the agent's **Learning** tab. First come notes: short rules it keeps for itself. Then a skill, the how-to it keeps
following. Once that skill has served a few runs, the agent writes the job down as a workflow: fixed steps that call
the tools directly, small judgment steps, and a hand-back to the full agent for anything it can't back up. Approve what
it proposes, or let it through on its own.

Add one line to the agent's instructions so its workflows run cheap: "In a workflow you write, put judgment steps on the
`fast` tier." From then on, every run gets the workflow as one tool, `learned_workflow`, and reaches for it first. The
strong model only does the hard cases.

## 5. Check the bill

Each run shows its cost, with the learning turn and every workflow step booked on it. In our run the cost dropped the
moment the workflow took over, at run 21, and stayed there. Compare it to a few runs with learning off to see the
saving all-in.

## 6. Keep it honest with a holdout

Before you trust it, keep a set of inputs aside that the agent never learns on, and score it there with learning off
and on. The [learning bench](../../packages/serve/learn-bench/README.md) runs exactly this, learning off and on, and
reports cost per run, how often it follows what it learned, and how often it reuses its workflow.
