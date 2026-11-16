---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
`GET /v2/computers` never lists a paired computer as online with `seen_at: null`. The attach hub has a socket live before the store keeps its hello, and a list between the two read online and never seen. `seen_at` is now the live socket's hello time while the computer is attached (`AttachHub.since(id)`), else the last one kept.
- The probe's diagnose test holds its closed UDP port for the whole test (a socket connected elsewhere, so the kernel refuses the probe's datagram) instead of binding and freeing one, which another process on a CI runner bound and answered from.
