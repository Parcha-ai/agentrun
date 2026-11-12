# Teach an expensive agent, run a cheap one

> **The idea:** a strong model figures the job out and writes it down as a workflow. A cheap model runs the workflow.
> The strong model only gets the hard cases. That's how we took
> [merchant classification from $0.89 to $0.124](../case-studies/merchant-classification.md).

Works for any job you do over and over with different inputs: classifying, checking documents, due diligence, triage.

## 1. Pick two models

The agent runs on the strong one. Workflow steps run on the `fast` tier, your cheap one.

```sh
AGENT_MODEL=openrouter/anthropic/claude-opus-5.5 \
AGENT_MODEL_FAST=openrouter/openai/gpt-6-luna \
npx @parcha/agentrun
```

## 2. Make the agent, learning on

```sh
cat > agent.json <<'EOF'
{"definition": {"id": "mcc", "version": 1, "name": "Merchant codes",
  "instructions": "Given a merchant's name and website, answer the exact 4-digit MCC, with the URL and the quote that decided it. In a workflow you write, put judgment steps on the fast tier.",
  "skills": [], "tools": ["web_search", "web_fetch"], "learning": true}}
EOF
npx @parcha/agentrun agents create --body @agent.json
```

That last line of the instructions is what makes its workflows run cheap.

## 3. Be its reviewer

Run it on real inputs. After each run, tell it how it did, as a follow-up on the same run:

```sh
npx @parcha/agentrun runs message "$run" --content "Right answer: 5691. You said 5651. The site only sells women's clothing."
```

At the end of every run, the agent looks back at the whole conversation and keeps what helps. Your feedback included.

Two rules:
- Give feedback when it's right too, not only when it's wrong.
- Give feedback on every field you care about. The one you never mention is the one it gets sloppy on.

## 4. Watch it write the workflow

Open the agent's **Learning** tab:

1. **Notes** come first: short rules it keeps for itself.
2. **A skill** next: the how-to it keeps following.
3. **A workflow** once that skill has served a few runs: fixed steps, small judgment steps, and a hand-back to the full
   agent when it can't back up an answer.

From then on, every run gets the workflow as one tool, `learned_workflow`, and reaches for it first.

## 5. Check the bill

Every run shows what it cost, learning and workflow steps included. Ours dropped the run the workflow took over and
stayed down.

## 6. Prove it on a holdout

Keep some inputs the agent never learns on, and score it there with learning off and on. The
[learning bench](../../packages/serve/learn-bench/README.md) does exactly this and reports cost per run, how often it
follows what it learned, and how often it reuses its workflow.
