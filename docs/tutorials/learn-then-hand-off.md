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

Every run stops before it finishes and asks you to check its answer. Answer it:

```sh
npx @parcha/agentrun runs message "$run" --content "Right answer: 5691. You said 5651. The site only sells women's clothing."
```

Then the run finishes, looks back at the whole conversation and keeps what helps, your answer included. Tell it when
it's right too, and cover every field you care about. The one you never mention is the one it gets sloppy on.

## 4. Watch it learn

Open the agent's **Learning** tab. Notes show up first, then a skill, then a workflow once that skill has done the job
a few times. From then on every run reaches for the workflow first.

## 5. Check the bill

Every run shows its cost, learning included. Ours dropped the run the workflow took over and stayed there.

To prove it, keep some inputs it never learns on and compare learning off and on. The
[learning bench](../../packages/serve/learn-bench/README.md) does that for you.
