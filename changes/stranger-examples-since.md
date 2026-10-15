---
packages: repo
kind: ci
---
**The examples' Since cells are enforced by the stranger test**
- `scripts/stranger.mjs` reads the examples index (`packages/pi-durable-disk/examples/README.md`) and, for every keyless
  example whose Since is at or below the registry's `beta` tag, installs exactly that published version in an empty
  directory (the index's own install line), copies the example's files, runs `node main.ts` and expects its `ok:` line. An
  example above the beta is skipped with the reason printed. It runs in the existing `stranger` job through the
  `pi-durable-disk` spec (`examples` key), so it needs no workflow change; `node scripts/stranger.mjs pi-durable-disk
  --examples` runs only this check. An example that claims a Since its imports do not have fails, naming the missing export.
