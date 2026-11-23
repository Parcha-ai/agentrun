---
packages: @parcha/agentrun-serve
kind: feature
---
Two more ways to run AgentRun Server (deploy/README.md). On Fly.io, `sh deploy/fly/launch.sh <app name>` deploys `deploy/fly/fly.toml`: the release's image on one Machine that is never stopped, with a 10 GB volume at `/data`. It makes the token and the seal key once, as Fly secrets, and never prints them. On DigitalOcean, `deploy/digitalocean/user-data.sh`, pasted as a new Droplet's startup script, runs the `--vps` install on its first boot.
