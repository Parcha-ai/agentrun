---
packages: @parcha/agentrun-computer
kind: feature
---
The E2B provider takes `apiUrl` (an https URL, default `https://api.<domain>`), and `@parcha/agentrun-computer/e2b` exports `E2BHost`, so a vendor that runs E2B's envd and API at its own URL (Cube) builds its host on E2B's with its `apiUrl`.
- `src/host.ts`, `PROVIDERS.md` and `spec/computer/provider.md`: a vendor's record of a machine that is deleted and won't come back (Runloop's `shutdown`, Blaxel's `TERMINATED`) reads `undefined` from `get` and is left out of `list`; `gone` is a machine still being destroyed, which holds the wait after a delete.
- `src/host.ts`: `daemon: "child"` says what `PROVIDERS.md` says: the vendor starts the adapter's processes through exec, and the adapter starts init that way at boot.
