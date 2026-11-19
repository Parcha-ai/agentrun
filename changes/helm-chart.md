---
packages: repo
kind: feature
---
AgentRun Server has a Helm chart, `deploy/helm/agentrun`: `helm install agentrun deploy/helm/agentrun` runs the release's image as one pod on a 10 GiB volume, with the token and seal key made as a Secret at install and kept on upgrade (or your own, with `existingSecret`). `helm uninstall` keeps the Secret and the volume, so a reinstall under the same name takes up every run and the keys. `ingress.enabled` adds an Ingress, whose address is the console's unless `env.AGENTRUN_PUBLIC_URL` sets another. Agents get file tools and `web_fetch`, no shell.
