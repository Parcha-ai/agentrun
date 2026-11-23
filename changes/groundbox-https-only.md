---
packages: @parcha/agentrun-computer
kind: breaking
---
The Groundbox provider's `apiUrl` must be https, a loopback host's included: an `http://` URL is refused, so the key never crosses in the clear. In 0.1.0-beta.54 it also took http to a loopback host. Who breaks: a caller pointing `apiUrl` at a local Groundbox stand-in over `http://`, who serves the stand-in over https instead.
