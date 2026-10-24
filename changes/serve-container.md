---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve` runs in one container: `--listen ADDR` listens on another address than 127.0.0.1 (there every `Host` name is served and the token is the only lock), and `AGENTRUN_TOKEN` gives the token in place of `DIR/.token`'s and is never printed. The repository has `packages/serve/docker/Dockerfile` (the server and the open packages it runs, everything it keeps under `/data`), a compose example that publishes the port on loopback only, and `render.yaml`, a Render blueprint with a persistent disk and a generated token.
