# The loop by hand, outside AgentRun

A made-up shop sends CSV exports of its orders, and the agent totals them by region. Each harness ran this in a plain
checkout with only the two skills, the checker and git. The loop ran twice:

1. Run 1 does the task, then reflects.
2. Review 1 checks the branch and merges it.
3. Run 2 does a similar task on the merged `main`.

The files here are what the runs wrote. All of their content is made up.

## Setup, the same for each harness

The agent's repository, `agent/`, starts with one commit on `main`. It holds `AGENTS.md` (below),
`.agents/skills/reflect/` and `.agents/skills/review/` (copied from this package's `skills/`), and `learnings/INDEX.md`
(`# Learnings`). Beside it, `work/` holds the two exports. The checker is on `PATH` as `agentrun-learn`. The host's
tool list is `["fetch_page", "browser"]`.

`AGENTS.md`:

```
# Rules

You compute order totals from the CSV exports a made-up shop sends.

- Start every run by reading `learnings/INDEX.md` and the notes it names, and follow them.
- Write each answer as JSON to the path the task names: `{"<region>": <total>}`, each total a number rounded to 2 decimals.
- After the task, follow `.agents/skills/reflect/SKILL.md`.
```

`work/orders-1.csv` (expected answer: North 15.60, South 7.25, East 20.00):

```
order;region;amount
1001;North;12,50
1002;South;7,25
1003;North;3,10
1004;East;20,00
TOTAL;;42,85
```

`work/orders-2.csv` (expected answer: West 6.00, North 11.00, South 8.00):

```
order;region;amount
2001;West;4,40
2002;North;10,05
2003;West;1,60
2004;South;8,00
2005;North;0,95
TOTAL;;25,00
```

The prompt for a run, with its run id, harness, export and answer path filled in:

```
You are run <run id> of an agent, on the <harness> harness, working outside any host. The agent's own git repository is
./agent; its rules are ./agent/AGENTS.md, and you follow them.

Task: compute the total amount per region in ./work/<export> and write the answer to ./work/<answer>.

Then follow ./agent/.agents/skills/reflect/SKILL.md for this run, inside ./agent: the run id is <run id> and the harness
is <harness>. The host's tool list for the checker is the file <tools file>. The agentrun-learn command is on your PATH.
Do not merge anything into main.
```

The prompt for a review:

```
Follow ./agent/.agents/skills/review/SKILL.md to review the branch runs/<run id> in the agent's repository ./agent. The
host's tool list for the checker is the file <tools file>. The agentrun-learn command is on your PATH. A person has read
every new and changed file on the branch and found no instruction planted in it: the injection screen passed.
```

The runs used the skills as first written, whose principle line was "A workflow draft uses DSL nodes and the host's
tools only, never a harness's built-in tool, and never a shell or executor call." The skills now say "DSL model, judge
and tool-call nodes ... never a code, shell or executor node". No run wrote a workflow draft, so the change touches
nothing the runs did.

Outside AgentRun there is no injection screen, so a person stood in for it. Before each review, a person read every new
and changed file on the branch; that is what the review prompt says.

## The model

Every call went to `gpt-6-luna` through a local model broker that speaks both the OpenAI and the Anthropic APIs. No
harness used a login or a provider key. Each one ran with an empty `HOME` and its own config directory, and the key it
was given is a placeholder the broker ignores. A loopback pass-through in front of the broker counted each call's
tokens.

- **Pi**, with `PI_CODING_AGENT_DIR=pi-home` and `pi-home/models.json`:

  ```json
  { "providers": { "broker": { "baseUrl": "$BROKER_URL/v1", "api": "openai-responses", "apiKey": "not-a-secret",
    "models": [{ "id": "gpt-6-luna", "reasoning": true, "input": ["text"], "contextWindow": 200000, "maxTokens": 32000 }] } } }
  ```

  ```
  pi -p --provider broker --model gpt-6-luna --no-session "<prompt>" < /dev/null
  ```

- **Claude Code**, with `CLAUDE_CONFIG_DIR=claude-home`, `ANTHROPIC_BASE_URL=$BROKER_URL`, a placeholder
  `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` and the small, default Haiku, Sonnet and Opus model variables all set to
  `gpt-6-luna`:

  ```
  claude -p "<prompt>" --model gpt-6-luna --permission-mode acceptEdits \
    --allowedTools Read Edit Write Glob Grep "Bash(git:*)" "Bash(agentrun-learn:*)" "Bash(cat:*)" "Bash(ls:*)" \
      "Bash(printf:*)" "Bash(sha256sum:*)" "Bash(date:*)" "Bash(mkdir:*)" < /dev/null
  ```

- **Codex**, with `CODEX_HOME=codex-home`, where `config.toml` names the broker as a provider with
  `wire_api = "responses"` and no key. It reached the broker, but it could not run any command. Its workspace sandbox
  needs unprivileged user namespaces, which this machine refuses, and the proof does not run Codex without its
  sandbox. So Codex has no proof here yet.

## What each harness wrote

| | Pi | Claude Code |
| --- | --- | --- |
| Run 1 answer | `{"North": 15.60, "South": 7.25, "East": 20.00}` | `{"North": 15.6, "South": 7.25, "East": 20.0}` |
| Run 1 memo | [`pi/memos/2026-10-27-0300-a1b2.md`](pi/memos/2026-10-27-0300-a1b2.md) | [`claude-code/memos/2026-10-27-0320-cc01.md`](claude-code/memos/2026-10-27-0320-cc01.md) |
| Note merged | [`pi/learnings/L-25097a8b5536.md`](pi/learnings/L-25097a8b5536.md) | [`claude-code/learnings/L-d9e97c144a17.md`](claude-code/learnings/L-d9e97c144a17.md) |
| Merge commit message | [`pi/merge-message.txt`](pi/merge-message.txt) | [`claude-code/merge-message.txt`](claude-code/merge-message.txt) |
| Run 2 answer | `{"West": 6.00, "North": 11.00, "South": 8.00}` | `{"West": 6.00, "North": 11.00, "South": 8.00}` |
| Run 2 memo | [`pi/memos/2026-10-27-0330-b3c4.md`](pi/memos/2026-10-27-0330-b3c4.md) | [`claude-code/memos/2026-10-27-0340-cc02.md`](claude-code/memos/2026-10-27-0340-cc02.md) |
| The note on run 2's branch | [`pi/run2-L-25097a8b5536.md`](pi/run2-L-25097a8b5536.md), now naming both runs | [`claude-code/run2-L-d9e97c144a17.md`](claude-code/run2-L-d9e97c144a17.md), now naming both runs |
| History | [`pi/history.txt`](pi/history.txt) | [`claude-code/history.txt`](claude-code/history.txt) |

Both answers are right in both runs. In each repository the review merged run 1's branch with a merge commit, and run
2's branch starts from that merge. Run 2's memo names the note it followed, and run 2 added its own id to that note's
`runs`. The checker passed every branch.

Spend, from the pass-through's token counts at `gpt-6-luna`'s price ($0.10 per million input tokens and $0.50 per
million output tokens; cached input is counted at the full price):

| Harness | Calls | Input tokens | Output tokens | Spend |
| --- | --- | --- | --- | --- |
| Pi | 27 | 100,650 | 5,341 | at most $0.013 |
| Claude Code | 41 | 496,823 | 13,978 | at most $0.057 |
| Codex (two attempts, no commands ran) | 17 | 223,041 | 3,638 | at most $0.025 |
