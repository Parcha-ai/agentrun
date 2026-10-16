---
packages: @parcha/agentrun-pi
kind: fix
---
`/agentrun status` names the supported Pi range, `>=1.0.4 <1.4.0` (the range of the package's pi-durable and chord peers), and flags only a host outside it, suggesting the newest version CI tests: `npm install -g @earendil-works/pi-coding-agent@1.3.0`. It compared the host with one version, 1.1.0, so it flagged every supported host but 1.1.0 and told it to install 1.1.0. A host outside the range is still not blocked.
