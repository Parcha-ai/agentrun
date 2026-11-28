---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
Groundbox and Orgo computers now say the size they run at, so their time is priced. Groundbox reads `cpus`, `memory_gb` and `disk_gb` from each sandbox it answers. Orgo reads `ram` and `cpu` from its create answer, or from its read of the computer when a create is retried, and falls back to the size it asked for when the answer leaves one out. Before this, both reported no resources, their `compute_time` line had a null quantity, and their time was booked as nothing even with a price set.
A provider descriptor gains `sized`: whether its create answers the size the vendor runs each computer at. A metered provider that isn't `sized` now has its computer time unpriced for every resource (`GET /v2/settings/prices` answers `usd: null`, `source: "unpriced"`), whatever its `AGENTRUN_COMPUTE_USD_PER_*` settings say. A size only the spec asked for is not one the vendor said it billed. That applies today to boxd, cloudflare, morph, smolcloud, sprites and vercel. A caller that refuses uncounted time sees them as uncounted until each reports its size.
