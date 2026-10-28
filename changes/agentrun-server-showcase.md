---
packages: repo
kind: docs
---
The README's first screen is AgentRun Server: one compose command from a checkout, the link it prints, a new agent, a run, and every run on one page. `examples/agentrun-server/` holds a showcase to seed into any running server through `/v2`: three agents with their revisions and 29 sample runs, among them one agent's three revisions side by side, from a plain prompt to a workflow with one fast model step. `showcase.mjs --token-file /data/.token --runs` seeds it from inside the compose container, whose image build now takes that folder.
