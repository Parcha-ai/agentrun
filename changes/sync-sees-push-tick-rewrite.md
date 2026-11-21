---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
A synced folder now sees a file rewritten to the same size in the push's own clock tick (a command that lands tens of milliseconds after the claim's push, on a filesystem whose timestamps come from the kernel's coarse clock). Before, such a file kept the size and mtime the baseline listing recorded, and the runner's copy kept the old bytes for good. The claim's push now gives every file `PUSHED_MTIME` (2000-01-01T00:00:00Z) in its tar header, so any later write moves its mtime, and nothing is read back after the push.
computerd's `tar.push` now gives each file its tar header's mtime, as tar and the macOS computerd already did, instead of the time of the extraction. `TarEntry` takes an optional `mtime` (whole seconds) for the header; without one it is the time the entry is written, as before.
