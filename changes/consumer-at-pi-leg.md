---
packages: repo
kind: ci
---
`node scripts/verify-packages.mjs --pi <x.y.z>` installs the clean consumer's pi family at that version and runs the reference example there, and the `pi-1-2` job runs it at 1.2.0. The example's token counts are checked as counts, not exact numbers, because they move with any text a pi release changes in a tool description.
