---
packages: @parcha/pi-transport, @parcha/agentrun-serve
kind: fix
---
**A Daytona box's host list holds after a restart, and an odd read of it never leaves a sandbox behind**
- serve: a run's Daytona box found at its next call is kept only when its domain list is the one `AGENTRUN_BOX_ALLOW` names now (the same hosts, in any order). A box made under a wider list, or one whose list Daytona does not say, is destroyed and made again, so a narrowed setting holds for a run whose server restarted.
- pi-transport: a box's facts carry its hosts in `allow`. A `domainAllowList` read back as a list of hosts is taken; any value that is neither a string nor a list deletes the sandbox and refuses the create as `unsupported`, where it threw before and left the sandbox.
- serve: a Daytona box with no network after Daytona refused its list says why in `network_reason` (`reason` stays for an unavailable box), and the log line gives Daytona's own words (`event=box_network ... message="..."`).
