---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose process fails as it starts is no longer started again while its end is being written. The first message's delivery could start a second process in that window, so the run read `failed` while that process still held its place under `--max-runs`, and the next start was refused (429). Nothing starts a run's process now while a settle of that run is in progress.
