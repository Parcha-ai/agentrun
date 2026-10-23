---
packages: @parcha/pi-durable-disk
kind: fix
---
Archil's latest: the package depends on the `disk` SDK 1.9.0 (was 1.7.0), and the Docker image installs the `archil` client 0.10.0 (was 0.8.42), checked by sha256 per architecture. The SDK calls the claim, lease and supervisor make are the same in 1.9.0, which adds disk branches and sandbox mounts; the client verbs the package runs take the same arguments in 0.10.0, whose `mount` adds `--kernel-read-ahead-kb`. A host that installs `disk` itself installs 1.9.0, so npm keeps one copy. A host's own client may stay at 0.8.40 or later.
