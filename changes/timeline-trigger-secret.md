---
packages: @parcha/agentrun-serve
kind: fix
---
A webhook trigger's secret is cut from every Timeline row, as a saved key is: by its value in each of its forms (hex, base64, JSON-escaped), not only by its `whsec_` shape, and from a run's title and answer too. After a rotation the new secret is cut at once. Upgrading: nothing to do.
