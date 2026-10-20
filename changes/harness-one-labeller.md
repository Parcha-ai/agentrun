---
packages: @parcha/agentrun-harness
kind: feature
---
A demo with a place of its own can pass `providers`: when the place has `Place.labelBox({ provider, key })`, its host boxes and the tools' boxes share one `box-N` numbering run-wide. `--box-ids` (`DemoOptions.boxIds`) names a directory, one file per label (`box-N.json`) claimed by an exclusive `link(2)`, so two processes or hosts never take one label; a run started on the earlier single file has its labels read in at its first claim.
The place hands each runner its host box as `HOST_BOX` (JSON `{ provider, key, run }`: its start index and the supervisor life's `RUN_LABEL`). The runner claims that label first, before any model call or tool box, and the place only reads it back (`undefined` until it is there).
A host box that any read listed and that has no label at the run's end refuses the recording. So do: a place without `labelBox` beside `providers`, a disk with no exclusive link, a read-only mount, a directory that takes no files, a malformed `HOST_BOX`, and a host box key claimed in another supervisor life. A run with a place's host boxes and `providers` is re-taken, not resumed. `hostBoxLabel` and `parseHostBox` are exported for places that implement `labelBox`.
