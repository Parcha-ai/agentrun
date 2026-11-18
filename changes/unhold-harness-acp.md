---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-harness-acp`, the adapter that runs an Agent Client Protocol agent as a harness (Goose's among them), is no longer held: the next release publishes it, after the kernel and before the server. `@parcha/agentrun-serve` now depends on it, so a server installed from npm has the Goose row: its owner installs Goose's pinned binary with `agentrun-serve install-harness goose --data <dir>`, restarts the server, and Goose is offered. The package's archive holds `dist`, Goose's recipe (`recipes/goose.json`), the README, LICENSE and NOTICE; `scripts/verify-packages.mjs` imports its root and `./facts` in the clean consumer and reads the recipe from the installed package.
