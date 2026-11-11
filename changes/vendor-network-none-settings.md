---
packages: @parcha/agentrun-serve
kind: fix
---
Settings → Computers (`GET /v2/computers`) no longer offers a computer that needs a network (a cloud phone, Browserbase, Kernel, Local Chrome) on a server whose `AGENTRUN_BOX_ALLOW` is none. Such a provider reads `ready: false`, and its `why` says the server has no network and how to change that. Its `network` says the server refuses a computer that needs a network. A kind that only such providers serve reads `offered: false`, saying why. Its runs were already refused at the start and at the claim. Under a host list, the default or the operator's, nothing changes.
