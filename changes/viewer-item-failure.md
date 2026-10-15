---
packages: repo
kind: feature
---
**`apps/viewer`: a collecting map's failed items**
- `./items.ts` gives panels `itemFailureOf(path, item, pin)` (RECORDING.md draft 28): whether a map item failed in a map
  with `onItemFailure: "collect"`, read from the one place the run keeps it, its `agentrun.items` record (status
  `"failed"`, `outcome: { code, label, message }`) and otherwise the driver state's `pin.failures` (every failed item of a
  v3 run; in the keyed layout, an item of a map that committed before the run moved to it). It returns `{ failed, from }`,
  `undefined` when the item did not fail, or `{ unreadable }` when that place holds no outcome or the item is kept in
  both; it never guesses. PANELS.md documents it.
