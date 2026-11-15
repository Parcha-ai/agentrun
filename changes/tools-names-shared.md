---
packages: repo
kind: fix
---
The console reads a monid grant's name with the server's own tool-name grammar (`packages/serve/src/tool-names.ts`, bundled from its source through the console's `@agentrun/tool-names` alias) instead of a copy of it, so the two can no longer drift. What the console accepts and the words it refuses a name in are unchanged.
- `tool-names.ts` imports nothing, and a test holds it to that, so the console bundle never takes in the server. `WIRE_NAME` moved into it from `catalog.ts`.
- The root build rebuilds the console when `tool-names.ts` changes (it is one of the console's build inputs now).
