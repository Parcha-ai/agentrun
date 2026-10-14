---
packages: repo
kind: ci
---
CI gains two jobs. `pi-1-2` builds, type-checks and tests every package whose pi-family peer ranges accept pi 1.2.0 on that version, while the workspace develops on 1.1.0: `scripts/pi-leg.mjs` picks the packages from their ranges, installs one copy of each family package at the version, and fails on any other resolved copy. `agentrun-pi-pi-floor` runs `@parcha/agentrun-pi` with all six pi-family packages at 1.0.4, beside `@parcha/pi-durable-disk` at 1.0.4.
