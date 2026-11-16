---
packages: @parcha/agentrun-computer
kind: breaking
---
`MachineHost.exec` is optional: a host whose facts say `connect: "dial"` has no `exec` and no `upload`, so code that calls a host's `exec` itself checks it is there first. Such a host's create boots the box image with `MachineRequest.boot.env`, and the machine dials the server's attach route with a token minted for it alone (`MachineTokens`, `MemoryMachineTokens`, `mintedComputer`), which ends at delete or at the machine's `backstopAt`. `HostedProvider` takes `dial: { url, tokens, hub }`; without a public https address, or for an Archil mount or a desktop, it refuses in words before the vendor is called. The Core case `provider.dial-token` checks the token, given `ConformanceOptions.dial`. `spec/computer/attach.md`, `spec/computer/provider.md` and `PROVIDERS.md` ("Machines that dial in") say how.
