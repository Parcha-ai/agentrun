---
packages: @parcha/agentrun-serve
kind: fix
---
A run's live screen now opens behind a TLS proxy that sends `X-Forwarded-Proto: wss` on a WebSocket upgrade (Traefik does). The server took only `https` as TLS, so on the upgrade it looked for the plain-http session cookie instead of the owner's `__Host-agentrun-session`, answered `401`, and the viewer said "Disconnected. Open the live view again." while the rest of the console worked. `wss` now reads as `https` wherever the server reads the header; a proxy that sends `https` on upgrades was never affected.
