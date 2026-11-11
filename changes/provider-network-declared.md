---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Each computer provider declares the networks it makes without being built: its descriptor's `network` (`"none"`, `"open"`, `"allow"`; the `NetworkForm` type), which the kind registry's entry carries, and of which its `capabilities().network` is its own configuration's. Settings → Computers (`GET /v2/computers`) says what this server's allow-list means for a vendor-hosted computer in a provider's `network` field: "no network, so this server's allow-list isn't offered" for one that makes none alone (Daytona, E2B, Modal), and "the vendor's own network; this server's allow-list doesn't apply" for one on the vendor's own network (the cloud phone, Browserbase, Kernel). Docker, which takes the allow-list, has no such field, nor does Orgo, whose Linux desktop has no network and whose Windows desktop the vendor's own.
