---
packages: @parcha/pi-vision
kind: fix
---
The `look` skill says where scratch files go: frames, crops and drawn checks belong in a folder under the workspace, such as `.look/`, never in `/tmp` or any path outside it, because a file outside the workspace cannot be looked at. The `transcribe` skill drops "Stop when the task's budget would be passed": the run's one dollar stop is the host's, so the sentence about what a chunk costs (the per-minute price and the hour's estimate) stays as information and the `over_budget` code stays as a model's size limit.
