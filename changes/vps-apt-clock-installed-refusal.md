---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---

`install.sh --vps` stops waiting for apt's locks 600 s after its first try by the clock, so a try that first waited out dpkg's lock no longer adds another 600 s for each retry. An installed agentrun refused by an earlier version's data now says to move the folder aside and run the installer again, without an npx command that may not be there.
