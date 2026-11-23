---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server has a Northflank template (`deploy/northflank/template.json`, spec v1.2): the release's image as one service on the 1 vCPU / 2 GB plan with a 10 GB volume at `/data`, its health check on `/v2/health`, and the token, the seal key and the public address made by Northflank. Paste it into a new template in Northflank and run it; `deploy/README.md` gives the steps, the cost and where the setup code is. Agents get file tools and `web_fetch`, no shell; no model key needed.
