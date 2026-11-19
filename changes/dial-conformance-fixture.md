---
packages: @parcha/agentrun-serve
kind: feature
---
`dial-conformance.mjs` gives a desktop run the computerd-fixture binary, which the server's image now builds into `packages/computer/dist/computerd-fixture-linux-amd64`; without it a desktop's screen and input cases skipped and Core could not pass.
