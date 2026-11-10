# Deploying AgentRun: a server and its runners

AgentRun runs as two kinds of process on one store:

- **The server** serves the API and the console, sets the store up (it is the only one that migrates it), and records
  each run it starts. Started with `--no-runner`, it runs no run itself; without it, it runs one runner beside itself
  (a single container, as on Render).
- **A runner** claims runs from the store and runs them, many at once (`--loops`, default 300). Run as many runners as
  you need; each one holds a run under a claim it renews every 10 s. A runner that stops hands its runs back at once, and
  the runs of one that dies are claimed by another runner once their 30 s lease lapses.

Both come from one image, built from `packages/serve/docker/Dockerfile`, so a runner always knows the schema of the
store its server set up. Run the server and the runners from the same image tag.

## The image's two commands

```sh
# The server alone, with its runners in their own containers: the API on port 7340, everything under /data.
docker run --hostname server -v agentrun-data:/data -e AGENTRUN_SEAL_KEY ... agentrun-server \
  --data /data --listen server --port 7340 --drain-timeout 6s --no-runner

# A runner: the same image, `runner` as its command, the same /data, a name of its own.
docker run -v agentrun-data:/data -e AGENTRUN_SEAL_KEY ... agentrun-server runner --data /data --name runner-1 [--loops N]
```

The image's default command is the server with a runner beside it, for one container on its own.

What each takes, from its environment alone:

| Setting | Server | Runner | What it is |
| --- | --- | --- | --- |
| `AGENTRUN_SEAL_KEY` | required | required | The key saved model keys, tool keys and MCP credentials are sealed under. Set it explicitly, the same in every process (`openssl rand -base64 32`), and keep it. Without it the server keeps one in the data directory beside the store, made at the first start. A store whose secrets were sealed with another key refuses to start, in words: hand the server the original key. |
| `AGENTRUN_STORE_URL` | optional | optional | A `postgres://` URL for a Postgres store. Unset, the store is SQLite in `/data`, and every process must share that one volume. It holds the database's password, so it is a secret: give it from an env file or a secret store, never written into a compose file or a command line. The launcher hands it to the process over a pipe and keeps it out of the process environment, so no run sees it. |
| `AGENTRUN_STORE_SCHEMA` | optional | optional | The Postgres schema the store is in (default `agentrun`). |
| `AGENTRUN_RUNNER_NAME` | | optional | The runner's name when `--name` gives none: in the runs it claims, its log lines and its heartbeat. Give each runner its own. |
| `AGENTRUN_TOKEN` | optional | | The API token. Unset, the server makes one in `/data/.token` and prints it once. |
| Model keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AGENT_MODEL`, ...) | yes | yes | The runner makes a run's model requests; the server checks a run's model can run before it starts it. |

The server listens where `--listen` says: above, its container's own address (its hostname), where Docker publishes the
port. A runner listens on nothing.

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

**More runners.** Copy the `runner-2` service as `runner-3` and so on, with its own `--name` and the same name in its
health check. Every runner on SQLite must mount the same `agentrun-data` volume, so all of them run on this
one Docker host. To spread runners over machines, use a Postgres store.

**Postgres.** The `pg` profile runs a Postgres for the store. In `.env`:

```sh
AGENTRUN_PG_PASSWORD=<a password>
AGENTRUN_STORE_URL=postgres://agentrun:<the same password>@postgres:5432/agentrun
```

then `docker compose --profile pg up -d`. The server and runners do not wait for it: one that cannot reach its store yet
exits and is started again.

On a database you run yourself, the store's role needs no `CREATE` on the database when the schema is made ahead of time
and given to it (`CREATE SCHEMA agentrun AUTHORIZATION <role>`, or the name in `AGENTRUN_STORE_SCHEMA`): the server
migrates a schema its role owns.

**Render.** `render.yaml` at the repository's root runs the image's default command: the server with one runner beside
it, on a disk only that one service can mount. More runners on Render need the Postgres store: the server with
`--no-runner`, and each runner a background worker from the same image with `runner --data /data --name <name>`. A first
deploy needs one model key in Render's form, then `AGENTRUN_TOKEN` from the service's Environment tab at the first visit.
render.yaml has Render generate AGENTRUN_SEAL_KEY once; keep it with the service. More runners on Render need the same
value set on each worker.

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
