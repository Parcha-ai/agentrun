---
packages: repo
kind: feature
---
The reference entry takes `Fakes.input` (the no-key default input, a smaller slice than the job's own; `--input` wins), reports the models the live parts chose (`LiveParts.models`, handed to `manifest()` as `models`, so a demo needs no file handshake between its two hooks), and prints why a child stopped in the summary.
