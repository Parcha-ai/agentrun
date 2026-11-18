---
packages: repo
kind: feature
---
A Railway template for AgentRun Server, in `deploy/railway/template.json`: the published image as one service, a volume at `/data`, the health check on `/v2/health`, `AGENTRUN_TOKEN` and `AGENTRUN_SEAL_KEY` generated once per deploy, and `AGENTRUN_PUBLIC_URL` set to the service's Railway domain. `deploy/railway/publish-and-walk.sh` publishes it with a Railway token and walks one deploy of it into a throwaway project it deletes afterwards. `deploy/README.md` has the Deploy on Railway button for the published template, `agentrun`.
  - The console's setup-code hints know a Railway address (`*.up.railway.app`): the token is in the service's Variables tab, the setup line in its deployment's Deploy Logs.
  - `deploy/README.md` has a section per button with its cost and what happens after the click. The Render docs and `render.yaml` say that agents there get no shell.
