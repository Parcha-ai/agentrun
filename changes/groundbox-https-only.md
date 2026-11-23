---
packages: @parcha/agentrun-computer
kind: fix
---
The Groundbox provider's `apiUrl` must be https, a loopback host's included: an `http://` URL is refused, so the key never crosses in the clear.
