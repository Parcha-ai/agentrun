# AgentRun Server showcase

Three agents to seed into any running AgentRun Server ([`packages/serve`](../../packages/serve/README.md)), each with the
revisions and sample runs that show what the server keeps: every revision of an agent, written once, and every run
pinned to the revision it ran.

| Agent | Revisions | Runs | What it shows |
| --- | --- | --- | --- |
| MCC classifier | A: a plain prompt. B: the same with a rubric skill from the card networks' published rules. C: a workflow that reads the home page and asks one fast model step. | the same 8 merchants on each | three revisions side by side: the same answers at a fraction of the cost |
| Issue triage | one prompt | 2 public GitHub issues | a prompt agent that reads a page and labels it |
| Company researcher | two prompts, the second asking it to name its sources | 3 companies | an edit as a revision, and runs on each |

Every agent reads public web pages with the server's `fetch_page` tool, which reaches public hosts only. No agent
names a model: each runs on the server's `AGENT_MODEL`, and revision C's model step on its fast tier,
`AGENT_MODEL_FAST`.

## Seed it

With a server running, and its token from the `AGENTRUN_API_KEY` line it prints:

```sh
export AGENTRUN_API_KEY=...
node examples/agentrun-server/showcase.mjs --url http://127.0.0.1:7340          # the agents and their revisions
node examples/agentrun-server/showcase.mjs --url http://127.0.0.1:7340 --runs   # and the 29 sample runs
```

In the container from [the compose example](../../packages/serve/docker/compose.yaml), with no Node on your machine and
the token read from the server's own data folder:

```sh
docker compose -f packages/serve/docker/compose.yaml exec agentrun \
  node examples/agentrun-server/showcase.mjs --token-file /data/.token --runs
```

`--only mcc-classifier` seeds one agent. A second seed leaves an agent that has its revisions as it is, and starts only
the runs. The runs spend model tokens: on a small model the 29 cost a few cents.

Then open the server's page: the agents, each agent's revisions and runs, and All runs.

The definitions and inputs are in [`showcase.json`](showcase.json): each agent is the `POST /v2/agents` body of its
first revision, the `PUT /v2/agents/{id}/definition` bodies of the next ones, and the `POST /v2/agents/{id}/runs` inputs,
each naming its revision by position.
