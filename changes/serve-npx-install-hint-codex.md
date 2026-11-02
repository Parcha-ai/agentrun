---
packages: @parcha/agentrun-serve
kind: fix
---
A missing Codex now names the line that fixes it for how the server was started, as claude-agent's SDK does. Run from npx, its reason gives `npx -p @parcha/agentrun-serve@<this version> -p @openai/codex@0.164.0 agentrun-serve`; installed in a project, the `npm install --save-exact @openai/codex@0.164.0` line, as before.
