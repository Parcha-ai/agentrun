---
packages: repo
kind: feature
---
AgentRun Server has a Helm chart, published with each release: `helm install agentrun oci://ghcr.io/parcha-ai/charts/agentrun --devel` (the newest beta) runs the release's image as one pod on a 10 GiB volume, with no checkout. The token and seal key are made as a Secret at install and kept on upgrade (or your own, with `existingSecret`). `helm uninstall` keeps the Secret and the volume, so a reinstall under the same name takes up every run and the keys. `ingress.enabled` adds an Ingress. Agents get file tools and `web_fetch`, no shell. From a checkout, `helm install agentrun deploy/helm/agentrun`.
