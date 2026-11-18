# Deploy and Host AgentRun with Railway

AgentRun is an open-source platform that runs your agents with self-improvement, durable execution and a control plane
on top of the agent harness you already use (Claude Agent, Codex, pi, OpenCode). This template deploys AgentRun Server,
its API, its console and a runner, as one service.

## About Hosting AgentRun

The template runs the published `ghcr.io/parcha-ai/agentrun-server` image as one service with a volume at `/data`. The
volume keeps the store, the agents' files and the coding harnesses the server installs on first use. Railway's health
check reads `/v2/health`. Each deploy makes its own API token (`AGENTRUN_TOKEN`) and seal key (`AGENTRUN_SEAL_KEY`), and
sets `AGENTRUN_PUBLIC_URL` to the service's Railway domain.

Open that domain once the deploy is active. The first visit asks for a setup code, so paste the value of
`AGENTRUN_TOKEN` from the service's Variables tab and set your password. Then Continue with ChatGPT or add a model key in
the console. You don't need a model key to deploy.

## Common Use Cases

- Scheduled and triggered agents that keep running after your laptop closes
- Code review, research and support agents your team calls over an API
- Long runs that resume where they stopped after a restart or a redeploy
- One console for runs, costs and what each agent learned

## Dependencies for AgentRun Hosting

- The AgentRun Server image, `ghcr.io/parcha-ai/agentrun-server:beta` (the newest release)
- A Railway volume for `/data`

### Deployment Dependencies

- Source and docs: https://github.com/Parcha-ai/agentrun
- Self-hosting guide: https://github.com/Parcha-ai/agentrun/blob/main/deploy/README.md

### Implementation Details

Railway mounts the volume as root. The service starts as root only to give the volume to the server's own user, then
runs the server as that user. The service has no Docker to run a sandbox in, so its agents get file tools and
`web_fetch` but no shell. Use the Hobby plan or above, because the trial's 0.5 GB volume can't hold Claude Code and
Codex (about 1 GB, installed onto the volume on first use).

### Why Deploy AgentRun on Railway?

One click gives you a server at an HTTPS address with its own token, seal key and volume, and nothing to set before the
first visit. Railway bills by use, so an idle server costs a few dollars a month.
