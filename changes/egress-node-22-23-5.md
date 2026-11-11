---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
Security: the Docker egress proxies now run Node 22.23.5, Node 22's November 2026 security release. The computer provider's `EGRESS_IMAGE` and the server's proxy on macOS Docker move from Node 22.23.4 (bookworm) to `node:22.23.5-trixie-slim`, pinned to its multi-arch index digest (amd64 and arm64). None of that release's CVEs reached the proxies: they speak cleartext `node:http`/`node:net` and pass TLS through CONNECT without terminating it. The new image also brings the release's llhttp, which parses the HTTP the proxies read from a box. A host without registry access pulls the new image ahead, as before: `docker pull` the name `EGRESS_IMAGE` gives.
