---
packages: repo
kind: feature
---
**`apps/viewer`: one rebuild of a v4 item's state for every panel**
- `./items.ts` gives panels `itemStateOf(item, states, path)`: the DSL's own `itemState` (RECORDING.md draft 26, the
  keyed layout), run with the page's synchronous SHA-256, returning `{ state }` or `{ unreadable }`, and
  `statesBySha(values)` for the `agentrun.states` lookup it takes. `partialResultsOf(partial, states)` reads a failed
  map's finished results from the driver's `pin.partial` through the DSL's own `partialResults`, inline in a v3 pin and
  by the list of slot digests in the keyed layout, each slot `null`, `{ result }` or `{ unreadable }`. PANELS.md
  documents both.
- The build reads `packages/dsl/src/recovery/item-state.ts` from the DSL's source at build time, inlines it in a scope of
  its own, and refuses to build if it ever imports anything; it is the one file outside the viewer a viewer module may
  import. Both run with the page's own synchronous SHA-256, `sha256Hex` from `./receipt-key.ts`.
