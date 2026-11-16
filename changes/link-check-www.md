---
packages: @parcha/agentrun-serve
kind: fix
---
The eval link check now treats a host and the same host with `www.` in front as the same, whether the `www.` is on the cited link or on the call's URL. A citation of `https://www.cpsc.gov/x` now matches a call that returned `https://cpsc.gov/x`, and the reverse. Before, it read "no matching call". No other subdomain is dropped, so `m.`, `amp.` and the rest still have to match exactly.
