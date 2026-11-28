---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` installs one pi-ai, the version the server is tested with. The server takes `@earendil-works/pi-ai` as a peer at `*`, and nothing pinned it. npm installed the newest pi-ai, 1.7.0, which the server was never tested with, and nested a copy of the tested 1.5.2 under each of the four pi packages that pin it, each copy with its own OpenAI and Google SDKs. The command now pins pi-ai beside the server: one copy each of pi-ai, openai and @google/genai, and about 190 MB less in `node_modules`. The release preflight refuses a command whose pin differs from the version `package-lock.json` installs.
