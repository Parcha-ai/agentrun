# Getting started

What you need before you start AgentRun, and three ways to start it. Every step here was walked on the published
`0.1.0-beta.31`.

## What you need

**A machine.** Node 22.19 or newer on macOS or Linux. Docker is optional: without it agents have no shell; with it every
agent gets a sandbox of its own with `bash`. The first start with Docker builds the box image, 5 to 10 minutes. You can
make agents while it builds, and a run started early waits for it.

**One model key.** Any one of these is enough.

| Key | pi | Claude Code | Codex |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | yes (GPT-6 Sol by default) | yes (Sonnet 5.5) | yes (GPT-6 Sol) |
| `ANTHROPIC_API_KEY` | yes | yes | no |
| `OPENAI_API_KEY` | yes | no | yes |

Set it where AgentRun starts, or add it in the console under Settings → Model keys, which takes effect at once. A
Claude or ChatGPT subscription sign-in is not an API key. Don't put an `ANTHROPIC_*` or `OPENAI_*` variable beside an
OpenRouter key for the same harness: the direct key wins, and a wrong or stale one fails the run instead of falling back.
An empty line (`ANTHROPIC_API_KEY=`) counts as unset.

**Harness packages.** pi is built in. On the published `0.1.0-beta.31` (`@parcha/agentrun` 0.3.6), Claude Code
agents need `-p @anthropic-ai/claude-agent-sdk@0.3.286` and Codex agents need `-p @openai/codex@0.164.0` on the `npx`
line; both on one line run all three. From beta.32 on, Claude Code installs on first use and the plain line is enough;
Codex keeps its `-p`. The Claude Code app is not needed on the machine, only the Agent SDK package, which the line
above pulls from npm. Your own Claude Code or Codex is a convenience for doing the install, nothing more.

**Workflows.** A workflow's model nodes run on the model key. Its decision nodes (`judge`, `pick`, `sift`, `route`,
`ask`) run on Jev with `TYPESAFE_API_KEY`, or through OpenRouter on `OPENROUTER_API_KEY`. A node that says
`provider: "openrouter"` runs OpenRouter's decision models on that same key; `provider: "parallel"` needs
`PARALLEL_API_KEY`. Three workflows that run on the OpenRouter key alone, with no agent loop, are in
[workflows/](workflows/). [Decision workflows](../../packages/serve/README.md#decision-workflows).

**Tools.** `web_search` and `web_fetch` need no key: the harness's own search where it has one, else keyless Exa.
`PARALLEL_API_KEY` picks Parallel for search and fetch. `MONID_API_KEY` unlocks monid's paid data tools. `browser`
needs Browserbase (`BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`) or Kernel (`KERNEL_API_KEY`). Keys go in the
console under Settings → Tool keys; each is checked against its provider before it is kept.
[Tools](../../packages/serve/README.md#tools) · [Tool keys](../../packages/serve/README.md#tool-keys)

## Three ways to start

### On your laptop

```sh
npx @parcha/agentrun
```

For Claude Code or Codex agents on beta.31, name the harness:

```sh
# Claude Code agents
npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun --data ~/.agentrun
# Codex agents
npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @openai/codex@0.164.0 agentrun --data ~/.agentrun
```

It prints `AgentRun is running at http://127.0.0.1:7340/` (another port if 7340 is busy) and opens the console. Set
the owner password on the first visit, 12 characters or more. Then Settings → Model keys, add one key. Then
[first-agent/](first-agent/).

### On a Linux server or VM

[linux-server/](linux-server/): a systemd user unit, an env file for the key, the ssh tunnel to the console, and
the same steps as a prompt for Claude Code.

### Let your coding agent do it

Paste into Claude Code or Codex:

```text
Read https://raw.githubusercontent.com/Parcha-ai/agentrun/main/docs/SKILL.md and set up AgentRun for me
```

It checks Node and Docker, starts AgentRun, asks before each step that changes your machine, and never sees your key.
[docs/SKILL.md](../../docs/SKILL.md).

## Then

[first-agent/](first-agent/): two agent definitions and the two prompts that show an agent learning a rule in one
run and following it in the next.

[workflows/](workflows/): three decision workflows with no agent in them. A decision model answers typed questions,
code applies the thresholds, a route sends the case on. Each is one JSON body to create and one line to run.
