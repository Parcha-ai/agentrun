---
packages: repo
kind: ci
---
The daily npx walk ends with a row "one pi": in the tree `npx @parcha/agentrun` installed, each pi package the launcher pins (pi-ai) is there once, at the pinned version. The release preflight checks what the launcher declares; this row checks what npm installed from it, so a dependency that pulls in a second pi-ai turns the walk red. A launcher published before the pin is not checked, and the row says how many copies of pi-ai, openai and @google/genai it got.
