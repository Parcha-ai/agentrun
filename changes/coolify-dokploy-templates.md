---
packages: repo
kind: feature
---
AgentRun Server has templates for Coolify (`deploy/coolify/agentrun.yaml`) and Dokploy (`deploy/dokploy/agentrun/`): the release's image as one service with its data on a volume at `/data`, the token, the seal key and the domain made by the platform. No Docker socket, so agents get file tools and `web_fetch`, no shell; no model key needed. `deploy/README.md` gives the steps for each.
