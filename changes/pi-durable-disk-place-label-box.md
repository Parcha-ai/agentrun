---
packages: @parcha/pi-durable-disk
kind: feature
---
`archilPlace` gives its host boxes run-wide labels: `Place.labelBox({ provider, key })` returns the label (`box-N`) of the host box it started at `key` (its start index), numbered with the boxes the run's tools make, so no two boxes of a run share a label. Only the process that holds the run writes labels. A start puts `HOST_BOX` (`{ provider, key, run }`, `run` being the order's `RUN_LABEL`) in its order's environment, and the runner's process claims that label first, in `<root>/box-ids.internal/`; the place reads it over S3, bounded. A label that never lands is `LABEL_MISSING`, never a guess, and a key the place did not start in this supervisor's life is `LABEL_REFUSED`.
- A run with host boxes and tool boxes cannot resume across a supervisor restart (`--reuse` of an earlier take included): its labels are numbered within one supervisor's life, so its runner refuses the claim. A failed take is taken again, not resumed.
- New: `HostDriver.provider` (optional, the provider of the boxes a driver makes, known before a box exists; `daytonaHost` and `modalHost` set it), `Place.labelBox`, the place error codes `LABEL_REFUSED` and `LABEL_MISSING`, and `archilPlace`'s `labelWaitMs` and `labelPollMs`.
