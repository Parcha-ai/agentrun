---
packages: @parcha/pi-transport, @parcha/agentrun-serve
kind: feature
---
**A Daytona box reaches the package registries and GitHub, through Daytona's domain list**
- pi-transport: `daytonaBoxes` takes `network: { allow: [...] }` when every entry is a domain (a `*.` wildcard allowed), sends it as Daytona's `domainAllowList`, and reports `network: "allowlist"` only once the sandbox's own read carries that list. A sandbox whose read lacks it is deleted and the create refused as `unsupported`, as `networkBlockAll` is checked. A CIDR in the list is still refused.
- serve: a run's Daytona box gets the hosts `AGENTRUN_BOX_ALLOW` names. Unset, `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com` and `codeload.github.com`; a comma list replaces them; `none` blocks the network as before. `*`, an IP address or a CIDR refuses the start. Where Daytona keeps or takes no domain list (its tier 1 and 2), the box is made again with its network blocked, never open, and capabilities say why. Capabilities show the hosts in `places.allow` and each Daytona box's `network`.
