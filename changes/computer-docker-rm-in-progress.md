---
packages: @parcha/agentrun-computer
kind: fix
---
A Docker computer or egress proxy whose removal Docker answers is "already in progress" now counts as removed once it is gone, instead of failing the release, the janitor's sweep, or a failed create's cleanup (and with it a takeover's release of older epochs). The provider looks again every half second, for at most 10 s; one still there by then fails in words that name it.
