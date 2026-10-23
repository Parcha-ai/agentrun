---
packages: @parcha/pi-durable-disk
kind: fix
---
Archil's latest SDK: the package depends on the `disk` SDK 1.9.0 (was 1.7.0). The SDK calls the claim, lease and supervisor make are the same in 1.9.0, which adds disk branches and sandbox mounts. The client verbs the package runs take the same arguments in client 0.10.0, whose `mount` adds `--kernel-read-ahead-kb`. A host that installs `disk` itself installs 1.9.0, so npm keeps one copy.
