---
packages: @parcha/agentrun-harness
kind: feature
---
A place of the demo's own whose host driver makes boxes (disk's `boxHost`) gets each host box's life in the recording, by the run's one box numbering: `DemoOptions.place`'s context gains `hostTap`, with `provider(p)` (the provider the host driver makes its boxes with, tapped) and `unheld(run, start)` (the place's unheld-window hook, disk's K9 shape; the harness declares `UnheldRun`, `UnheldStart` and `HostTap`). The supervisor writes a host box's lines as its own host lines (RECORDING.md, "Box lines (two writers)"): `box.created` (role `host`, with `from`), `box.exec` per command (with `at` when it was held), `box.ended` (`killed` when the supervisor took the box away), each with its process in `data.gen`.
- The run's process binds a host box's label (by `link(2)` on its mount); the unheld window writes only a pending entry of its own start's, never a label. The lines wait until the supervisor reads the bound label, then come in order; a recording never carries a pending name.
- A host box no window announced is refused before any box is made; a start with no host box is refused by `unheld`, so `unheld` is passed only with the tapped provider.
- A recording whose lines would name two boxes under one label is refused, naming the label: when a host box's bound label is already named in it, and at the end for any label.
- The viewer validates the three host kinds with `data.gen` and lists host and tool boxes together in the transport panel; `box.exec` is validated, not drawn. RECORDING.md documents the tool boxes' transport lines in the same section.
