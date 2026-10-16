---
packages: @parcha/pi-transport
kind: feature
---
`e2bBoxes(Sandbox, { template })` (`@parcha/pi-transport/box/e2b`): boxes that are E2B sandboxes (Firecracker microVMs), through
the host's own E2B SDK (pass its `Sandbox` class; this package depends on no E2B SDK). E2B ends a box at its timeout on its own
side. The template decides the size, so `cpus`, `memoryMb`, `region`, `gpu`, a snapshot and any isolation but `vm` are refused with
`unsupported`. A program's output reaches the host as text (the SDK's callbacks give strings), so only UTF-8 survives it; files and
input keep every byte, and the box says `bulk: "files"`. `registerBoxConformance` takes `textOutput: true` for such a provider: its
byte-value case then carries 0 to 127.
