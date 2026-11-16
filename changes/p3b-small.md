---
packages: @parcha/agentrun-computer
kind: feature
---
`src/host.ts`, `PROVIDERS.md` and `spec/computer/provider.md`: a vendor's record of a machine that is deleted and won't come back (Hyperbrowser's `closed`, Blaxel's `TERMINATED`) reads `undefined` from `get` and is left out of `list`; `gone` is a machine still being destroyed, which holds the wait after a delete.
- `src/host.ts`: `daemon: "child"` says what `PROVIDERS.md` says: the vendor starts the adapter's processes through exec, and the adapter starts init that way at boot.
