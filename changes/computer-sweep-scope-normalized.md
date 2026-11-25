---
packages: @parcha/agentrun-computer
kind: fix
---
The live sweep names a provider's server by its normalized URL, so `HTTPS://api.modal.com`, `https://api.modal.com:443`, `https://api.modal.com/` and the unset default are one scope, not four. This holds for Modal, Agent37, Morph, Groundbox, smol cloud and the Cloudflare relay. A before file written by an earlier version may name its server the old way: take a new one with `--before`.
