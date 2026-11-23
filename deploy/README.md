# Self-hosting AgentRun: a server and its runners

Want AgentRun hosted for you? Start with [AgentRun Cloud](../docs/getting-started.md#agentrun-cloud).
This guide covers the open-source deployment you operate: its server, runners, persistent storage and upgrades.

AgentRun runs as two kinds of process on one store:

- **The server** serves the API and the console, sets the store up (it is the only one that migrates it), and records
  each run it starts. Started with `--no-runner`, it runs no run itself; without it, it runs one runner in its own
  process. The image's default command runs the server with `--no-runner` and one runner as two processes in a single
  container (as on Render).
- **A runner** claims runs from the store and runs them, many at once, as many as its host's memory holds by each run's
  harness (a claude-agent run 288 MB, a pi run 128 MB; its host's memory is its container's limit when it has one, so
  give each runner on a shared host its own) and at most `--loops` (default `AGENTRUN_MAX_RUNS`, else as
  many pi runs as its host's memory holds, as the server's `--max-runs`); the rest wait queued. Run as many runners as
  you need; each one holds a run under a claim it renews every 10 s. A runner that stops lets each busy run finish its
  turn for up to `--drain-timeout` (default `AGENTRUN_DRAIN_TIMEOUT`, else `6s`, the image's server drain), then hands the rest back, and the runs of
  one that dies are claimed by another runner once their 30 s lease lapses.

Both come from one image, built from `packages/serve/docker/Dockerfile`, so a runner always knows the schema of the
store its server set up. Run the server and the runners from the same image tag.

None of the ways below needs a model key. Once the server is up, open its console, set your password, then Continue
with ChatGPT (Settings → Model keys, or the first screen), then run your first agent. Or add a model key there instead:
keys work as before, beside the sign-in. Codex and pi agents run on a ChatGPT plan; Claude Agent, OpenCode, Jev
decisions and paid tools need their own keys.

**Your server, your ChatGPT plan, only you:** a ChatGPT sign-in is for the person who runs this server. Don't share it
or let others run agents on it. Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT
settings. On a server that isn't this computer (Render, or a container), the sign-in tab ends on a page that won't
load: copy its whole address into the console.

## One container, no key

The server and one runner in one container, two processes on one data volume, its port on this machine's loopback:

```sh
(umask 077; [ -f agentrun.env ] || echo "AGENTRUN_SEAL_KEY=$(openssl rand -base64 32)" > agentrun.env)   # once; keep this file
docker run -d --name agentrun --restart unless-stopped -p 127.0.0.1:7340:7340 -v agentrun-data:/data --env-file agentrun.env -e AGENTRUN_PUBLIC_URL=http://127.0.0.1:7340/ ghcr.io/parcha-ai/agentrun-server:beta
docker logs agentrun     # the console's link, the first visit's setup code and, the first time, the token
```

`agentrun.env` keeps the seal key outside the container and the volume, so a container made again with the same file
opens the same store. The container has no Docker socket, so its agents get file tools and `web_fetch` but no shell; for
a Docker sandbox, use `compose.yaml` at the repository's root. Put a TLS proxy in front before you publish the port
anywhere else.

## One click: Render or Railway

Each button deploys the published image as one service, the server with one runner beside it, and keeps its data on a
disk at `/data`. The host generates the API token and the seal key. Neither host gives the service Docker, so its agents
get file tools and `web_fetch` but no shell. Neither needs a model key.

### Render

One fixed-price Render instance, from [`render.yaml`](../render.yaml).

It costs $25 a month for the 1 CPU / 2 GB instance and $2.50 for the 10 GB disk, at Render's prices when this was
written. Render needs a card on the workspace.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Parcha-ai/agentrun)

Once you click, Render asks for a name and the optional model keys. Leave the keys blank. Render pulls the image and
starts the service. When it's live, open its `onrender.com` address and paste `AGENTRUN_TOKEN` from the service's
Environment tab as the setup code. Set your password, then Continue with ChatGPT or add a model key in the console.

`render.yaml` sets `AGENTRUN_RUN_USER=same`: Render hasn't been shown to keep the image helper's file capabilities, so
each run runs as the server's own user, still a process of its own. Keep `AGENTRUN_RUN_USER=same`; without it the
runner refuses to claim and every run answers `runner_refused` (packages/serve/README.md).

### Railway

One Railway service billed by use, from [`railway/template.json`](railway/template.json).

Railway bills the memory, CPU and volume the service uses. An idle server holds about 0.3 GB of memory, which is about
$3 a month at $10 per GB-month. The volume is $0.15 per GB-month, and each run adds memory and CPU while it runs. The
Hobby plan is $5 a month and includes $5 of usage. Use Hobby or above, because the trial's 0.5 GB volume can't hold
Claude Code and Codex (about 1 GB, installed onto the volume on first use).

<!-- railway-button: publish-and-walk.sh prints this line's replacement once the template is published -->
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/agentrun-1?utm_medium=integration&utm_source=button&utm_campaign=agentrun)

Once you click, Railway shows the service's variables, all filled in: the token and the seal key are made for you, and
there's nothing to type. Railway pulls the image, mounts a volume at `/data` and gives the service an `up.railway.app` domain.
When the deploy is active, open that domain and paste `AGENTRUN_TOKEN` from the service's Variables tab as the setup
code, or open the setup link in the deployment's Deploy Logs. Set your password, then Continue with ChatGPT or add a
model key in the console.

Railway mounts the volume as root. The service starts as root only to give the volume to the server's own user, then
runs the server as that user. The template sets `AGENTRUN_RUN_USER=same`, as `render.yaml` does and for the same reason:
each run runs as the server's own user, still a process of its own. Keep `AGENTRUN_RUN_USER=same`; without it the
runner refuses to claim and every run answers `runner_refused` (packages/serve/README.md).
`railway/publish-and-walk.sh` publishes the template from `template.json` and walks it.
Railway's API makes a template only by copying a project, and the copy drops plain values, optional flags and some
deploy settings. So `template.json` holds only what survives: `PORT` and `RAILWAY_RUN_UID` are written as one-character
secrets over a one-character alphabet (always `7340` and `0`), and model keys are added in the console, not as variables.
Railway's default draining time applies, so a redeploy stops the server without the runner's 31 s stop. A run in flight
then picks up again after the restart.

## One command on a server you rent

On a fresh Linux server (Ubuntu or Debian, x64 or arm64), logged in as root:

```sh
curl -fsSL https://agentrun.ai/install | sh -s -- --vps
```

Its agents get a shell in Docker sandboxes, and it stays private. In order, it:

1. Picks the release: the server image `ghcr.io/parcha-ai/agentrun-server:v<version>` that the latest `@parcha/agentrun`
   depends on. `--version V` picks another release; `--image IMAGE` names an image.
2. Uses the Docker already on the server, if it is Docker Engine 26 or later with the compose plugin, and never changes
   it. With no Docker, it installs Docker Engine and the compose plugin from Docker's apt repository, as
   [Docker's install guide](https://docs.docker.com/engine/install/ubuntu/) does.
3. Writes `/opt/agentrun` (mode 700): `compose.yaml`, written again on every run, and `.env` (mode 600), whose
   `AGENTRUN_TOKEN` and `AGENTRUN_SEAL_KEY` it makes once with `openssl rand` and then keeps. Lines you add to `.env`
   (a model key, a price, `AGENTRUN_BOX_ALLOW`) stay and reach the server. A `compose.override.yaml` of your own stays too.
4. Starts it with `docker compose up` and waits for its health check. If the first visit would not ask for the setup
   code, it stops the server and says so.
5. Prints the address, the setup link with its code, and the line that reads the code again later:
   `cd /opt/agentrun && docker compose logs agentrun | grep 'Set up this server' | tail -n 1`.

Running it again upgrades to the release it names and keeps the token, the seal key and the data volume.

Where you open it:

- **Tailscale logged in.** On your own tailnet only, at `https://<server>.<tailnet DNS name>/`, through `tailscale serve`,
  never Funnel, as `--tailscale` does on your own computer. The installer runs that step from the server's image with
  the server's `tailscale` and its socket. The address needs MagicDNS and HTTPS certificates on in your tailnet's
  [DNS settings](https://login.tailscale.com/admin/dns). Tailscale's Personal plan is free. `serve` reaches the server
  through Docker's private bridge, so the installer sets `AGENTRUN_TRUSTED_PROXIES=uniquelocal` in `.env`: each visitor's
  sign-in tries count under the address `X-Forwarded-For` names. That header decides only which address a try counts
  against, never who you are, and the server's limit on wrong passwords still holds, so a Docker box that fakes it can
  only spread its tries ([the sign-in limit](../packages/serve/README.md)).
- **No Tailscale, or logged out.** The server's loopback only. The installer prints the steps (install Tailscale, then
  `tailscale up`) and the command to run again, and exits 0. It never installs Tailscale or logs in for you. Until
  then, open it through an SSH tunnel: the installer prints the one `ssh -N -L` line to run on your computer.
- **`--public`.** Every address of the server, port 7340, over plain HTTP, at `http://<its IPv4 address>:7340/`. Behind
  NAT, name the address: `curl -fsSL https://agentrun.ai/install | AGENTRUN_PUBLIC_URL=http://<address>:7340/ sh -s --
  --vps --public`. Before it starts, the installer says what this exposes. Anyone who reaches the address reaches the
  console and the API, and the setup code, your password and the token cross the network unencrypted. A later run
  without `--public` makes it private again.

The server's container gets the server's Docker socket, so a run's computer can be a Docker sandbox: a container beside
it with no socket, every capability dropped, no network but its egress proxy (`AGENTRUN_BOX_ALLOW`, by default the
package registries and GitHub), and only its run's folder of the data volume. Whatever reaches that socket is root on
the server, and the AgentRun server reaches it. Keep the server for AgentRun alone, with no other services, keys or
data on it.

It runs on 1 GB of memory, with room for a run or two at once; 2 GB holds more. At the providers' prices when this was
written, a Hetzner Cloud CPX02 (1 vCPU, 1 GB, 20 GB) is from €5.49 a month before VAT
([pricing](https://www.hetzner.com/cloud/regular-performance)), and a DigitalOcean Basic Droplet (1 vCPU, 1 GiB, 25
GiB) is $6 a month ([pricing](https://www.digitalocean.com/pricing/droplets)). The $4 Droplet's 512 MiB is too little.

## On Kubernetes, with Helm

```sh
helm install agentrun oci://ghcr.io/parcha-ai/charts/agentrun --devel --namespace agentrun --create-namespace
```

One pod, the server and its runner, on a 10 GiB volume, from the release's image; the token and seal key are made as a
Secret at install and kept on upgrade. Its agents get file tools and `web_fetch` but no shell, as on Render. The
chart's [README](helm/agentrun/README.md) covers Argo CD and Flux, and what `helm uninstall` keeps (the Secret and the
volume).

## On Coolify or Dokploy

Each template runs the release's image as one service, the server with its runner beside it, with its data on a
volume at `/data` and a 2 GB memory limit, which the runner budgets runs by (set `AGENTRUN_MEMORY` to change it). The
platform generates the token and the seal key once, with its own secret generator, and gives the service its domain.
Neither template mounts the Docker socket, which would hand agents the host: they get file tools and `web_fetch`, no
shell, as on Render. No model key is needed; for a shell, add a sandbox provider's key in the console.

### Coolify

From [`coolify/agentrun.yaml`](coolify/agentrun.yaml), in the shape of Coolify's own templates:

1. In a project, add a resource: **Docker Compose Empty**.
2. Paste the file, save, and deploy.

Coolify makes `SERVICE_URL_AGENTRUN` (an `sslip.io` address until you give the service a domain),
`SERVICE_HEX_64_AGENTRUN` (the token) and `SERVICE_REALBASE64_32_SEALKEY` (the seal key). Read the token in the
service's Environment Variables and paste it as the setup code at the first visit. If you give the service your own
domain, redeploy so `AGENTRUN_PUBLIC_URL` follows it.

### Dokploy

From [`dokploy/agentrun/`](dokploy/agentrun), a `docker-compose.yml` and a `template.toml` in the shape of Dokploy's own
templates:

1. From `deploy/`, encode the two files:

   ```sh
   jq -n --rawfile compose dokploy/agentrun/docker-compose.yml --rawfile config dokploy/agentrun/template.toml \
     '{compose: $compose, config: $config}' | base64 -w0
   ```

2. In a project, create a **Compose** service.
3. On its **Advanced** tab, under **Import**, paste the output, import, and deploy.

Dokploy makes the domain (`${domain}`, an `sslip.io` address), the token (`${hash:64}`) and the seal key
(`${base64:32}`), and writes them to the service's Environment. Read `AGENTRUN_TOKEN` there and paste it as the setup
code at the first visit. Dokploy's generated domain is http. If you give the service your own domain with HTTPS, set
`AGENTRUN_PUBLIC_URL` to it in the Environment and redeploy.

## The first visit's setup code

A server at a public address (`AGENTRUN_PUBLIC_URL`, or Render's own) asks for a setup code before it takes the first
password. The console says where to look and never shows the code. It is in one of these places:

| Server | Where the code is |
| --- | --- |
| Render | The service's **Environment** tab: paste the value of `AGENTRUN_TOKEN` as the code. Or its **Logs** tab: the line below. |
| Railway | The service's **Variables** tab: paste the value of `AGENTRUN_TOKEN` as the code. Or the deployment's **Deploy Logs**: the line below. |
| A server you rent (`--vps`) | The installer prints it. Later: `cd /opt/agentrun && docker compose logs agentrun \| grep 'Set up this server' \| tail -n 1`. Or `AGENTRUN_TOKEN` in `/opt/agentrun/.env`. |
| Docker | `docker logs agentrun` (compose: `docker compose logs`, which needs no service name: it is `server` in `deploy/compose.yaml` and `agentrun` in the root `compose.yaml`): the newest line `Set up this server: <address>/setup#code=<code>`. Open its link, or paste the code. |
| Any | The API token stands in for the code: `AGENTRUN_TOKEN`, or `/data/.token` when the server made its own. |

A code works once and lasts 30 minutes from the moment its line was printed. When it has run out, get a new one
without restarting:

- In the console, press **Get a new code** under the Setup code field. It says where the new line is and until when
  it works.
- Or, from anywhere that reaches the server, with no credential: `curl -sS -X POST <address>/v2/setup/code`.

Either prints a new `Set up this server:` line in the log only when the last code is expired or spent, and answers
`{"printed": true|false, "expires_at": "<time>"}`, never the code. A code that is still good is kept (`printed:
false`), so asking never voids a link you hold; the answer is a 403 once the owner is set. A restart prints a new code
too, as does a fifth wrong try.

If someone else makes the first visit (you deployed the server for them), send them the place, or the newest setup
link, in the same message as the console's address, and say in it that the link works once, when it expires, and that
Get a new code replaces an expired one. The token does not expire: say where it is, never paste it into a chat.

## The image's two commands

```sh
# The server alone, with its runners in their own containers: the API on port 7340, everything under /data.
docker run --hostname server -v agentrun-data:/data --env-file agentrun.env ghcr.io/parcha-ai/agentrun-server:beta \
  --data /data --listen server --port 7340 --drain-timeout 6s --no-runner

# A runner: the same image, `runner` as its command, the same /data, a name of its own.
docker run -v agentrun-data:/data --env-file agentrun.env ghcr.io/parcha-ai/agentrun-server:beta runner --data /data --name runner-1 [--loops N] [--drain-timeout D]
```

The image's default command, for one container on its own (above), is
`server-and-runner --data /data --listen 0.0.0.0 --port 7340 --drain-timeout 6s`. It starts the server with those options
and `--no-runner`, and one runner on the same data once the server answers `GET /v2/health`. The runner takes the
server's `--data`, `--drain-timeout`, `--max-runs` (as `--loops`), `--faux`, `--faux-browser` and each `--harness-module`. Each process has its own store
connection, so a busy runner never holds up the API. A `docker stop` reaches both, and each drains as it does on its
own. If either exits, the other stops and the container exits non-zero, so a restart policy starts both again.

Any other arguments are one command, run as given: `runner ...` is a runner, `reset-password --data /data` resets the
password, and server options alone are a server with its runner in its own process, which a paired computer needs, and
so does a provider whose machines dial the server (Fly Machines and Cloudflare). Under `server-and-runner`, Settings →
Computers says so on each such provider's row (`runs_refused` in `GET /v2/computers`), and its Test connection fails
naming the fix.

What each takes, from its environment alone:

| Setting | Server | Runner | What it is |
| --- | --- | --- | --- |
| `AGENTRUN_SEAL_KEY` | required | required | The key saved model keys, tool keys and MCP credentials are sealed under. Set it explicitly, the same in every process (`openssl rand -base64 32`), and keep it. Without it the server keeps one in the data directory beside the store, made at the first start. A store whose secrets were sealed with another key refuses to start, in words: hand the server the original key. |
| `AGENTRUN_STORE_URL` | optional | optional | A `postgres://` URL for a Postgres store. Unset, the store is SQLite in `/data`, and every process must share that one volume. It holds the database's password, so it is a secret: give it from an env file or a secret store, never written into a compose file or a command line. The launcher hands it to the process over a pipe and keeps it out of the process environment, so no run sees it. |
| `AGENTRUN_STORE_SCHEMA` | optional | optional | The Postgres schema the store is in (default `agentrun`). One server holds a schema at a time (its owner lock). A server started while another holds it waits up to 2 minutes for it to let go, then serves; past that it exits 1. Deploy the server with recreate (stop the old one, start the new one): the new one takes the schema as soon as the old one lets it go. API calls fail for the few seconds the new server takes to start, so a launcher should retry them. A deploy that waits for the new server to be healthy before stopping the old one can't hand a schema over, since the new one isn't healthy until it holds the schema. A server whose owner-lock connection is lost (a failover, a restarted database) refuses calls while it takes the lock back, and exits 1 if another server has taken it, so its platform restarts it. |
| `AGENTRUN_STORE_POOL_SIZE` | optional | optional | The most connections this process's Postgres store holds at once (default `10`): a whole number from 1 to 1000; any other value stops the process at start, in words. Each process holds its own pool, plus one connection for renewing claims, and the server one more for its owner lock, so a server with a runner beside it holds up to twice the size plus three. Keep the sum over every server and runner below the database's `max_connections`. With the SQLite store the size has no effect, but a value that is no size still stops the start. |
| `AGENTRUN_MAX_RUNS` | optional | optional | The most runs at once: the server's `--max-runs` and a runner's `--loops` when not given. Unset, as many pi runs as the host's memory holds. |
| `AGENTRUN_RUN_USER` | optional | optional | Unset, each run runs as a user of its own (slot `s`: uid `1001 + s`) where the image's helper can switch, and the runner refuses to claim, in words, where the platform stripped its file capabilities or set `no-new-privileges`. `same`: every run as the runner's own user, each still a process of its own, said on the runner's log. The Render and Railway templates set `same`, since neither platform has been shown to keep the helper's file capabilities. |
| `AGENTRUN_RUN_SLOT_FIRST` | | optional | The first slot (0 to 255, default 0) of this runner's runs. Runners in containers of their own on one `/data` volume each take a range of their own, as `deploy/compose.yaml`'s do (0 and 128): two runs on one slot would be one user on the volume. |
| `AGENTRUN_DRAIN_TIMEOUT` | | optional | A runner's `--drain-timeout` when not given (`8s`, `500ms`, `1m`); unset, `6s`. Keep it plus 25 s below the grace a SIGKILL waits for. |
| `AGENTRUN_MCP_ALLOW_LOOPBACK` | optional | optional | `1` says this machine is one you alone use: an MCP server on loopback (`127.0.0.1`, `localhost`) is taken at the save and the pin (server) and reached by the runs (runner). Each process reads its own: set it on the server and on every runner that should reach one, and give each runner a server or forwarder at that address on its own loopback, which is its own container's or machine's, not the server's unless they share one. A runner never reaches loopback at a server's own port: 7340, a loopback `AGENTRUN_PUBLIC_URL`'s, or where the server listens (it keeps that in the store at each start). |
| `AGENTRUN_MCP_TOKEN_ORIGINS` | optional | optional | The origins an [API-only](../packages/serve/README.md#api-only) server's token may save a `per_run` MCP server at: comma-separated, each exactly `https://host[:port]`, or one `http://127.0.0.1:<port>` that counts only with `AGENTRUN_MCP_ALLOW_LOOPBACK=1`. A bad entry stops the start, in words. Unset, none. The server checks the origin of such a server again at each run's start, and each runner at each claim, against its own: give it the same list. |
| `AGENTRUN_RUNNER_NAME` | | optional | The runner's name when `--name` gives none: in the runs it claims, its log lines and its heartbeat. Give each runner its own. |
| `AGENTRUN_TOKEN` | optional | | The API token. Unset, the server makes one in `/data/.token` and prints it once. |
| `AGENTRUN_TOKENS` | optional | | More API tokens, as `id:secret` entries separated by commas ([Rotating the API token](#rotating-the-api-token)). Any of them opens what the token opens; the log names the id used. A secret, like the token. |
| Model keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AGENT_MODEL`, ...) | optional | optional | The runner makes a run's model requests; the server checks a run's model can run before it starts it. Give the same ones to both. With none, Continue with ChatGPT in the console, or save a key there. |
| `COMPOSIO_API_KEY` | optional | optional | The Composio account key a Composio MCP server saved with `api_key_env` reads (server: the save's calls to Composio, a refresh and the delete's; runner: each run's MCP connection to Composio). A secret: the launcher hands it to each process over a pipe, so neither process's environment holds it, and no run is handed it: the runner sends it only as the MCP header of a Composio server the run is granted a tool of. Give the same to both; a new value takes effect when they start again. |
| `AGENTRUN_LAUNCH_HOOK_URL` | optional | | The host's https address (plain http only to this machine): each trigger firing that would start a run is POSTed there, signed, and the host starts the run through the API ([Launch hook](../packages/serve/README.md#launch-hook)). Set with the secret below, or neither. |
| `AGENTRUN_LAUNCH_HOOK_SECRET` | optional | | The `whsec_` secret the launch hook signs with. A secret: the server's alone, never a runner's or a run's. |
| `AGENTRUN_API_ONLY` | optional | | `1` serves the run routes, a deploy's routes (a template's apply, an agent's read, revisions, rollback, archive and delete), the MCP servers' names, a Composio server's save (its key named by `api_key_env`, never in the request; a new name, or over a server the token saved), a `per_run` server's save at an origin `AGENTRUN_MCP_TOKEN_ORIGINS` lists and the delete of a server the token saved alone, for a server behind its caller's backend: the console, sign-in, setup, other settings, the MCP endpoint, triggers and hooks are `404`, and there are no accounts ([API only](../packages/serve/README.md#api-only)). Unset or `0`, the whole server. |
| `AGENTRUN_RUN_KEYS` | optional | | `1`: a template's apply makes its agent though a tool key it declares is not set here, with a warning, and each run of that agent must bring the key in `keys` (409 without it). Keys the server holds are still used by runs that bring none. No trigger is made whose firings would run that agent without its keys, unless the launch hook starts them ([Per-run tool keys](../packages/serve/README.md#per-run-tool-keys)). Unset or `0`, off. |

The server listens where `--listen` says: above, its container's own address (its hostname), where Docker publishes the
port. A runner listens on nothing.

A runner says it is ready in one line once it can claim runs, then what memory its runs may hold in another:

```
Runner runner-1 ready: store sqlite schema v<N>, <N> loops
Runner runner-1 memory: <N> MiB for runs, each weighed by its harness
```

The memory is its host's, or its container's limit, less 128 MiB kept for the process itself. From then it writes its
heartbeat, `/data/runner-<name>.alive`, as its loop turns. `runner --check --data /data --name <name>` checks the
runner's environment ([The runner's environment](#the-runners-environment-runner---check)) and that the heartbeat is
younger than 20 s, and exits 0 only when both hold: that is a runner's health check.

### A runner on a disk of its own

A runner needs no share of the server's disk when the store is Postgres and runs' folders are on Archil (Mode 2: the
Archil settings saved, or `AGENTRUN_ARCHIL_REGION` and `AGENTRUN_ARCHIL_S3_URL` set on both). Start it with
`AGENTRUN_STORE_URL`, `AGENTRUN_SEAL_KEY` and a `--data` of its own, a local directory: it holds only the runner's
heartbeat, its runs' uid slots, their scratch and the harnesses it installs at a claim. It never reads the server's.

The server keeps an id of its data root in `/data/data-root.id` and says it in the store at each start; a runner whose
`--data` holds another id, or none, is a runner on a disk of its own. While the server is in Mode 1 (no Archil
settings), each run's folder is on the server's disk, which such a runner can't reach, so it claims nothing and says why,
on its log and to the server:

```
agentrun-serve runner: Runner runner-1 claims nothing: this runner's data directory is not the server's, and the server keeps each run's folder on its own disk (Mode 1: the server holds no Archil settings, saved or in its environment), which this runner can't reach. Save the Archil settings so runs' folders are on Archil (Mode 2), or start the runner on the server's data directory.
```

It never fails a run for that. Runs wait for a runner on the server's data directory; while every runner there refuses,
the server refuses a new run (`503 runner_refused`, in the runner's words) and fails the runs still queued, as it does for
any runner that can't serve. The runner checks again every 5 s, and claims again once the Archil settings are saved. The
mode is the server's, never the runner's: Archil settings in a runner's environment alone do not let it claim, and a
runner that lacks them while the server has them in its own environment claims nothing and says to hand them over. A
store whose server is older than this release has said no data root, and every runner is taken as sharing its disk, as
before. A run's uploads (`file_ids`) need no disk of the server's in Mode 2: the server keeps them on its Archil disk and
places them in the run's folder at its start (changes/uploads-on-archil.md). Not on a disk of its own yet: screen
recordings, which the runner writes on its own disk where the server does not serve them.

### The runner's environment: `runner --check`

`agentrun-serve runner --check --env [--data D]` checks what a runner needs from its environment and prints one line per
name, never a value, then the outcome. It exits 0 when nothing is missing or bad, 1 otherwise (each gap on stderr too),
and 2 for bad arguments. Run it through the launcher, as the runner runs, so it reads the secrets the runner would; it
opens the store with one connection and closes it.

| Name | Checked |
| --- | --- |
| `AGENTRUN_STORE_URL` | The store opens, at a schema this runner knows. Unset, a SQLite store in `--data` (the server's) counts. |
| `AGENTRUN_SEAL_KEY` | It is the key the store's secrets are sealed under. Unset, the key file in `--data` counts. |
| `AGENTRUN_STORE_POOL_SIZE` | Only when set: a whole number from 1 to the store's most, as the runner's start takes it. The check itself opens one connection. |
| Every run-facing name the server holds | The server says the names (never the values) of its run-facing environment in the store at each start: model, tool and box keys, the Composio account key (`COMPOSIO_API_KEY`, which a claim sends as a granted Composio server's MCP header), each box provider's settings (`DAYTONA_TARGET`, `DAYTONA_ARCHIL_EGRESS`, ...), the Archil settings, the tiers' models (`AGENT_MODEL`, `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG`), `AGENTRUN_BOX_ALLOW`, a Docker computer's image and size (`AGENTRUN_DOCKER_IMAGE`, `AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY`, `AGENTRUN_BOX_PIDS`), the operator's bound on owners' private hosts (`AGENTRUN_PRIVATE_HOSTS`), how a gateway is sent a model id (`AGENT_MODEL_GATEWAY_IDS`), whether runs may reach an MCP server on loopback (`AGENTRUN_MCP_ALLOW_LOOPBACK`), the harness modules it loads (`AGENTRUN_SERVE_HARNESS_MODULES`, which a runner may hold as `--harness-module`, given to its check too; a server given them as `--harness-module` says nothing of them), and every upstream address (`*_BASE_URL`, `*_API_URL`). The runner must hold each one: a run's claim reads it from the runner's environment. A server older than this release says none, and this part is `skipped`. |
| Each `*_BASE_URL` / `*_API_URL` on loopback | Something answers a TCP connect there within 2 s: the forwarder beside the runner that the upstream names. |
| `AGENTRUN_TOKEN`, `AGENTRUN_TOKENS`, `AGENTRUN_API_KEY` | `warn` when set: the server's own secrets, which a runner never needs. Fails nothing. |
| `start` | What the runner's start refuses before it claims, checked the same way: its run slots (`AGENTRUN_MAX_RUNS`), drain (`AGENTRUN_DRAIN_TIMEOUT`), free-model requests, its Archil settings (the region and an https S3 URL set together), and its runs' isolation (`AGENTRUN_RUN_USER`, and whether the image's helper can switch users here). |

```
ok      AGENTRUN_STORE_URL  the store opens: postgres, schema v23
ok      AGENTRUN_SEAL_KEY   the store's seal key
ok      ANTHROPIC_BASE_URL  the server holds it, and so does this runner
missing MONID_API_KEY       the server holds it and a run's claim reads it here: hand it to this runner too
ok      ANTHROPIC_BASE_URL  on this machine's loopback, and a forwarder answers there
ok      start               the runner's start takes its settings: run slots, drain, free-model requests, Archil, run isolation
Runner environment: 1 gap: MONID_API_KEY
```

Without `--env`, `runner --check --data D --name N` checks the same environment and the heartbeat: use it as the
runner's readiness check and the deploy's gate. Its environment check opens the store, so a store that does not answer
fails it. For a liveness check that restarts a runner, use `runner --check --heartbeat --data D --name N`: the heartbeat
alone, with no store and no secret, so a database blip does not restart every runner. Start the server of the release
first: it says its names at its start.

A runner exits with:

| Code | Why |
| --- | --- |
| 0 | It was stopped (SIGTERM or SIGINT) and handed its runs back. |
| 2 | Bad arguments. |
| 3 | It can't run on the store's schema. The store isn't set up yet, or the server hasn't migrated it to this runner's version yet (start the server first), or the store's runner floor is above this runner's version (run a runner of the server's release). A runner checks the floor at its start and every 10 s after. When the floor rises while it runs, it first claims nothing more, drains and hands its runs back. |
| 1 | Anything else. |

**Upgrading on Postgres.** Deploy the server first: it migrates the store under the running runners, then roll the
runners. A runner opens a store a later server migrated as long as the store's runner floor is at most this runner's
schema version. Additive migrations leave the floor where it was, so the earlier runners keep running. A migration marked
breaking raises the floor, and each earlier runner then stops as above and exits 3. It notices at its next floor read,
up to 10 s after the migration commits, and keeps claiming until then; its drain and its hand-back then run its own
release's statements on the new schema. That is safe when the breaking migration is the cleanup a release later, which
removes only what the runners of the release before it no longer use (CONTRIBUTING.md). A hand-back that fails leaves
its runs to the claim's lease, which another runner takes when it lapses. To check a store before a deploy,
`agentrun-serve store-schema` prints its schema version and runner floor beside the version this build knows, as one
line of JSON, and changes nothing. A running server reports the same values in `GET /v2/capabilities` (`store_schema`).
`agentrun-serve store-schema --build` prints only the build's own versions, with no store. Never deploy a server whose
build is older than the store: it refuses the store.

On SIGTERM a runner claims nothing more and lets each busy run finish its turn for up to `--drain-timeout` (default 6 s),
so a model request in flight is not cut and sent again; then it stops the loops left where they can resume and hands
their runs back. A loop that does not stop is given up 25 s after that, so with the default drain a runner is done
within 31 s: give it 35 s before a SIGKILL, more with a longer drain. `--drain-timeout 0s` hands every run back at once.

## With Docker Compose: a server and two runners

`compose.yaml` in this directory runs the server and two runners on one `/data` volume (SQLite). In this directory, once:

```sh
printf 'AGENTRUN_SEAL_KEY=%s\n' "$(openssl rand -base64 32)" > .env && chmod 600 .env
```

A model key in `.env` (`ANTHROPIC_API_KEY=...`, say) is optional: with none, Continue with ChatGPT in the console once
it's up. Then:

```sh
docker compose up -d --build     # --build: this checkout's image, until a published one carries the runner command
docker compose logs server       # the server's link and, the first time, its token
docker compose logs runner-1     # Runner runner-1 ready: ...
```

The server's port is published on this machine's loopback (`127.0.0.1:7340`); put a reverse proxy with TLS in front of
it before you publish it anywhere else. Each runner starts once the server is healthy (only the server sets the store
up), is started again if it exits with an error, and is given 35 s to stop: its drain (6 s by default) and 25 s for a
stuck loop after it, 31 s in all.

**Memory.** Each runner container is limited to 2 GB (`mem_limit`), and a runner budgets its runs from that limit:
1920 MiB, six claude-agent runs or fifteen pi runs at once, the rest queued. Without a limit, each runner would read
the whole host's memory and budget all of it, so two runners on one host could take twice what it holds. Set
`AGENTRUN_RUNNER_MEMORY` in `.env` (`1g`, `4g`, ...) so the runners' limits together, with room for the server, fit
the host: about 5 GB for the default two. `docker compose logs runner-1` shows the budget each runner read
(`Runner runner-1 memory: 1920 MiB for runs, ...`). A run whose harness never fits a runner's limit (an opencode run,
704 MB, under `512m`) is never started there: the runner fails it at its claim, saying how much memory it needs. An
opencode run needs a limit of at least 832 MB (its 704 and the runner's own 128); a claude-agent run 416 MB.

**More runners.** Copy the `runner-2` service as `runner-3` and so on, with its own `--name`, `hostname` and
`AGENTRUN_RUNNER_LIVE_HOST`, the same name in its health check, and its host added to the server's
`AGENTRUN_RUNNER_HOSTS`. Every runner on SQLite must mount the same `agentrun-data` volume, so all of them run on this
one Docker host. To spread runners over machines, use a Postgres store.

**Live views on a runner apart from the server.** A run's browser, desktop or phone is watched and taken over through
the server, which reaches the runner's viewer. Each runner names the host the server reaches it at
(`AGENTRUN_RUNNER_LIVE_HOST`; its viewers listen there, or on `AGENTRUN_RUNNER_LIVE_BIND`), and the server dials only
the hosts in its `AGENTRUN_RUNNER_HOSTS`. Every request the server makes of a runner's viewer is signed with a key
derived from the seal key, and a runner takes no other. The hop is plain HTTP: keep the server and its runners on a
private network of their own, as this stack does. The attach relay's `ws://` hop, from the server to the runner that
made a dial computer, carries that machine's bearer token over the same private network, so the same rule covers it.
With neither setting, viewers stay on loopback, which is right when
the server and its runner share a machine (the default image's command).

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

**More runners on Render.** `render.yaml` runs the image's default command: the server and one runner, two processes in
one service, on a disk only that one service can mount. More runners on Render need the Postgres store: the server with
`--no-runner`, and each runner a background worker from the same image with `runner --data /data --name <name>`.
render.yaml has Render generate AGENTRUN_SEAL_KEY once; keep it with the service, and set the same value on each worker.

## Rotating the API token

The server takes a list of API tokens, each with an id. `AGENTRUN_TOKENS` holds the list as `id:secret` entries,
separated by commas or newlines; `AGENTRUN_TOKEN` (or `/data/.token` when neither is set) is the entry with the id
`default`. Any token on the list opens every route the token opens. Each presented token is compared against every
entry in constant time. Each request line in the log names the id of the token it used (`token=ci-2026-11`), never the
secret. Runners hold no API token, so a rotation touches the server alone.

| Setting | Format | Notes |
| --- | --- | --- |
| `AGENTRUN_TOKEN` | the secret | Id `default`. A server with only this setting has a one-entry list, as before. |
| `AGENTRUN_TOKENS` | `id:secret[,id:secret...]` | An id is a letter or digit, then up to 31 letters, digits, `.`, `_` or `-`. Each secret is 32 characters or more, with no whitespace or comma. An id or a secret given twice stops the start. |

To rotate with no downtime:

1. Add the new token. Make it (`openssl rand -hex 32`), add it as an entry (`AGENTRUN_TOKENS=ci-2026-11:<new>`, beside
   `AGENTRUN_TOKEN`), and restart the server. Check that its banner lists both ids (`API tokens taken (ids): default,
   ci-2026-11`) before you go on. Both tokens work now.
2. Move every caller (your backend, scripts, `AGENTRUN_API_KEY` for the CLI) to the new token, one at a time. Watch the
   request lines: when no line names the old id (`token=default`) any more, every caller has moved.
3. Remove the old token. Unset `AGENTRUN_TOKEN` (or drop its entry from `AGENTRUN_TOKENS`) and restart the server. The old
   token is refused from now on (`401`, logged as `wrong_token`).

No caller is refused at any step. Each step is a server restart, which drains as any stop does (`--drain-timeout`);
callers ride it out as they would any restart. A server whose token is in `/data/.token` rotates the same way: put that
token in the list as an entry (`old:<its secret>`) at step 1, since a server given `AGENTRUN_TOKENS` no longer reads the
file.

## Upgrading from an earlier server

There is no upgrade in place. The earlier server kept its agents in `/data/store.sqlite`, under the same name as the new
store's file, and the new server refuses to start on a data directory that holds one, saying so. Then either:

- keep running the earlier version on that volume, or
- start on a new data directory (a new volume) and re-create your agents there. Under compose or `docker run` that is
  new arguments after the image; on Render the Docker Command replaces the image's entrypoint too, so it must be the
  whole start command shown in the release notes' "Before you upgrade", not flags alone.

Nothing converts an earlier volume.

## The walks

`walk/` holds two walks of this stack on a faux model (`walk/faux-steps.mjs`: no model key, no network). Each starts its
own compose project with its own volume and seal key, prints a report (a `Verdict:` line, then a table of step, result and
evidence), and removes everything when it ends. Each starts on a new volume, never an earlier server's, and builds
this checkout's image.

- `walk/smoke.sh`, which CI runs: the server is healthy, both runners say they are ready, and a run of an agent in the
  runner's place completes, each of its steps done once.
- `walk/reclaim.sh`: a run of about 60 s whose runner is stopped in the middle, by SIGTERM and then by SIGKILL. Each time
  the other runner takes it over (read from `GET /v2/runs/{id}`'s `claim`), after a SIGKILL within the 30 s lease, and
  the run completes with each step done once.

`helm/walk.sh` (CI: `helm-walk.yml`, on kind) walks the chart: install, a first run, upgrade, uninstall and reinstall.
`selfhost/walk.sh coolify|dokploy` (CI: `selfhost-walk.yml`, each platform on a VM of its own) installs the platform, deploys
the template through its API, makes a first run and removes it with its volume.
Both walk the release's image. Every walk here walks `AGENTRUN_IMAGE=<image>` instead when it is set.

Every day, `ways-in-daily.yml` walks every way in on main, whatever changed: the README's `npx @parcha/agentrun` as
published (`packages/agentrun/test/npx-walk.sh`), main's launcher (`install-walk.yml`), and Docker Compose, Railway's
service, Helm, Coolify and Dokploy on main's image, built once for every row. Its summary is one table, each way in and
its result, with each walk's report under it. A red run opens the issue `ways in: <rows> broke`, or updates the open
one, and the next green run closes it.

Two walk the Railway template:

- `railway/local-walk.mjs`, which CI runs after the smoke walk: the template's service in Docker as Railway runs it (as
  root, its start command in place of the entrypoint, on a fresh volume owned by root). The volume ends up the server's
  user's, every process runs as that user, the first visit asks for the setup code, the token works as that code, and
  the password survives a restart.
- `railway/publish-and-walk.sh`, run by hand with a Railway token: the template deployed into a throwaway project, its
  health, its first visit and its token as the setup code, then the project deleted. With `--first-run` it also runs a
  no-tool agent to completion, its model key saved in the console as a person saves it. `--dry-run` prints the plan with no token;
  `--check-api` validates every operation it sends against Railway's live API.
