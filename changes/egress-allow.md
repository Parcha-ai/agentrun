---
packages: @parcha/agentrun-kernel
kind: feature
---
The egress proxy can take a host list: `startEgressProxy({ ..., allow: ["pypi.org", "*.pythonhosted.org"] })` lets a box reach only those hosts, on ports 80 and 443.
- An entry is an exact name or `*.suffix`, which covers the names below the suffix but not the suffix itself. Matching ignores case and a trailing dot.
- A host off the list, any IP literal and any other port are refused before any lookup, so a name off the list never leaves the host. The refusal is `403` (SOCKS5 reply 2) with the reason in plain words, for example `example.com is not on this box's network list`, followed by the caller's `allowHint`. Its `x-egress-refused` and log class is `not-listed`.
- A listed name then meets the address rule as before: one that resolves to private or metadata space is still refused.
- With no `allow`, nothing changes. `parseAllow` is exported, so a caller checks its setting with the code the proxy enforces it with.
