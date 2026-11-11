---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Local Chrome honors this server's `AGENTRUN_BOX_ALLOW` when the operator sets it: its egress proxy then reaches only those hosts, on ports 80 and 443, and refuses any other host by name before its lookup. The fence on this machine's loopback, private networks and the metadata address holds either way. With the setting unset, Local Chrome stays open: the default list is a sandbox's package registries, not a browsing policy. Under `none` it is refused at the run's start.
- `LocalBrowserProvider` declares network `["open", "allow"]` and takes `{ allow: [names and CIDRs] }`. A CIDR that covers a range the proxy refuses is refused at `check()`. `list`, `attach` and `network()` read the list back.
- A run's launch records whether the operator set `AGENTRUN_BOX_ALLOW` (`box_allow_set`), so a browser is held to the operator's list and never to the default.
- Settings → Computers says so for Local Chrome: "open unless this server sets AGENTRUN_BOX_ALLOW; then only those hosts".
- Under `AGENTRUN_BOX_ALLOW=none`, a computer whose provider makes no "none" is refused at the start and at the claim, now saying it "needs a network".
