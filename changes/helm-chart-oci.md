---
packages: repo
kind: feature
---
Each release publishes the Helm chart as `oci://ghcr.io/parcha-ai/charts/agentrun` at its own version, so `helm install agentrun oci://ghcr.io/parcha-ai/charts/agentrun --devel` (the newest beta) needs no checkout. The release notes' install lines name it.
