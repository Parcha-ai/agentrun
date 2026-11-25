---
packages: @parcha/agentrun-serve
kind: fix
---

A server in AgentRun's image with no Docker socket (Fly.io, Render, a Kubernetes pod) now says what Settings → Computers says: use a vendor computer, or, on a machine you run, give it the host's socket with compose.yaml. A `--faux` server in the image says the image's words too.
