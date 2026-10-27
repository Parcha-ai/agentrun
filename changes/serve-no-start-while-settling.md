---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose process fails as it starts is no longer started again while its end is being written. The first message's delivery could start a second process in that window, so the run read `failed` while that process still held its place under `--max-runs`, and the next start was refused (429). Nothing starts a run's process now while a settle of that run is in progress.

A run whose first message was still on its way when the server stopped no longer has its end written after the stop, into a store the stop had closed. The next start recovers the run and writes its end then. A run's first message also waits out a process that is slow to come up, up to the ready time (45 s), whatever deadline a later request to the run has.
