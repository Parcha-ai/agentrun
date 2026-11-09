# Deploying AgentRun: a server and its runners

AgentRun runs as two kinds of process on one store:

- **The server** serves the API and the console, sets the store up (it is the only one that migrates it), and records
  each run it starts. It runs no run itself.
- **A runner** claims runs from the store and runs them, many at once (`--loops`, default 300). Run as many runners as
  you need; each one holds a run under a claim it renews every 10 s. A runner that stops hands its runs back at once, and
  the runs of one that dies are claimed by another runner once their 30 s lease lapses.

Both come from one image, built from `packages/serve/docker/Dockerfile`, so a runner always knows the schema of the
store its server set up. Run the server and the runners from the same image tag.

## The image's two commands

```sh
# The server (the image's default command): the API on port 7340, everything under /data.
docker run -v agentrun-data:/data -e AGENTRUN_SEAL_KEY ... agentrun-server

# A runner: the same image, `runner` as its command, the same /data.
docker run -v agentrun-data:/data -e AGENTRUN_SEAL_KEY -e AGENTRUN_RUNNER_NAME=runner-1 ... agentrun-server runner --data /data [--loops N]
```

What each takes, from its environment alone:

| Setting | Server | Runner | What it is |
| --- | --- | --- | --- |
| `AGENTRUN_SEAL_KEY` | required | required | The key saved model keys, tool keys and MCP credentials are sealed under. The server and every runner must have the same one. Make it once with `openssl rand -base64 32` and keep it: losing it loses what it sealed. |
| `AGENTRUN_STORE_URL` | optional | optional | A `postgres://` URL for a Postgres store. Unset, the store is SQLite in `/data`, and every process must share that one volume. |
| `AGENTRUN_STORE_SCHEMA` | optional | optional | The Postgres schema the store is in (default `agentrun`). |
| `AGENTRUN_RUNNER_NAME` | | optional | The runner's name, in the runs it claims, its log lines and its heartbeat. Give each runner its own. |
| `AGENTRUN_TOKEN` | optional | | The API token. Unset, the server makes one in `/data/.token` and prints it once. |
| Model keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AGENT_MODEL`, ...) | yes | yes | The runner makes a run's model requests; the server checks a run's model can run before it starts it. |

The server listens where its arguments say: the image's default command listens on port 7340 on every interface of the
container, for Docker to publish. A runner listens on nothing.

A runner says it is ready in one line once it can claim runs:

```
Runner runner-1 ready: store sqlite schema v<N>, <N> loops
```

and from then writes its heartbeat, `/data/runner-<name>.alive`, as its loop turns. `runner --check --data /data --name
<name>` exits 0 while the heartbeat is younger than 20 s: that is a runner's health check.

A runner exits with:

| Code | Why |
| --- | --- |
| 0 | It was stopped (SIGTERM or SIGINT) and handed its runs back. |
| 2 | Bad arguments. |
| 3 | The store's schema is one it does not know, or the store is not set up yet. Start the server first; run a runner of the server's release. |
| 1 | Anything else. |

On SIGTERM a runner stops its loops where they can resume and hands their runs back at once; a loop that does not stop is
given up at 25 s. Give it 35 s before a SIGKILL.

## With Docker Compose: a server and two runners

`compose.yaml` in this directory runs the server and two runners on one `/data` volume (SQLite). In this directory, once:

```sh
printf 'AGENTRUN_SEAL_KEY=%s\n' "$(openssl rand -base64 32)" > .env && chmod 600 .env
```

Add your model keys to `.env` (`ANTHROPIC_API_KEY=...`, say), then:

```sh
docker compose up -d --build     # --build: this checkout's image, until a published one carries the runner command
docker compose logs server       # the server's link and, the first time, its token
docker compose logs runner-1     # Runner runner-1 ready: ...
```

The server's port is published on this machine's loopback (`127.0.0.1:7340`); put a reverse proxy with TLS in front of
it before you publish it anywhere else. Each runner starts once the server is healthy (only the server sets the store
up), is started again if it exits with an error, and is given 35 s to stop.

**More runners.** Copy the `runner-2` service as `runner-3` and so on, with its own `AGENTRUN_RUNNER_NAME` and the same
name in its health check. Every runner on SQLite must mount the same `agentrun-data` volume, so all of them run on this
one Docker host. To spread runners over machines, use a Postgres store.

**Postgres.** The `pg` profile runs a Postgres for the store. In `.env`:

```sh
AGENTRUN_PG_PASSWORD=<a password>
AGENTRUN_STORE_URL=postgres://agentrun:<the same password>@postgres:5432/agentrun
```

then `docker compose --profile pg up -d`. The server and runners do not wait for it: one that cannot reach its store yet
exits and is started again.

**Render.** `render.yaml` at the repository's root runs the server alone, on a disk only that one service can mount, so
no runner can share its SQLite store there. Runners on Render need the Postgres store, each runner a background worker
from the same image with `runner --data /data` as its command.

## Upgrading from an earlier server

There is no upgrade in place. The earlier server kept its agents in `/data/store.sqlite`, under the same name as the new
store's file, and the new server refuses to start on a data directory that holds one, saying so. Then either:

- keep running the earlier version on that volume, or
- start on a new data directory (a new volume) and re-create your agents there.

Nothing converts an earlier volume.

## The walks

`walk/` holds two walks of this stack on a faux model (`walk/faux-steps.mjs`: no model key, no network). Each starts its
own compose project with its own volume and seal key, prints a report (a `Verdict:` line, then a table of step, result and
evidence), and removes everything when it ends. Each starts on a new volume, never an earlier server's, and builds
this checkout's image, or walks `AGENTRUN_IMAGE` when set.

- `walk/smoke.sh`, which CI runs: the server is healthy, both runners say they are ready, and a run of an agent in the
  runner's place completes, each of its steps done once.
- `walk/reclaim.sh`: a run of about 60 s whose runner is stopped in the middle, by SIGTERM and then by SIGKILL. Each time
  the other runner takes it over (read from `GET /v2/runs/{id}`'s `claim`), after a SIGKILL within the 30 s lease, and
  the run completes with each step done once.
