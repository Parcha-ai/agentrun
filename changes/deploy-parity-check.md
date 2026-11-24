---
packages: repo
kind: ci
---
A deploy parity check: `node scripts/deploy-parity-read.mjs --source URL --source-agent ID --lock DIR/.agentrun/deploy.json` reads one agent on the install it came from and on the one `agentrun deploy` sent it to, and says field by field whether it is the same agent (harness, model and tiers, effort, instructions, every tool with its pin, each MCP tool by its source and toolkit, skills by content hash, declared keys, triggers, schemas, budget, learning, approvals). It exits 0 when it is, 1 naming each field missing, changed or extra, or each field an install did not serve. A fixture agent with one of each kind is deployed both ways (a folder, and an install's agent) in the agentrun package's tests, which fail naming any field a deploy drops.
