---
packages: @parcha/agentrun-serve
kind: feature
---
A hosted machine of a dial provider can dial this server. The server mints each machine a token at its create (`art_` and 64 hex, kept as its SHA-256 until the machine's backstop or its delete), and the attach socket (`GET /v2/computers/attach`) takes it as it takes a paired computer's: the socket stands for that machine, and a hello of another kind, os or arch than the machine was made as is closed with 4400. The machine fetches this server's own computerd build with the same token from the new `GET /v2/computers/daemon?arch=amd64|arm64` (ten fetches a minute per machine, then 429). An unknown, revoked or expired token is 401 on both, and the token is in no log line. The runner beside the server builds every remote provider with the server's dial: the address its machines dial (`AGENTRUN_PUBLIC_URL`; without one, a dial provider's create refuses), the tokens and the hub. A runner in its own process has none.
