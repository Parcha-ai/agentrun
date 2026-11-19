---
packages: repo
kind: feature
---
AgentRun Server has a Helm chart, `deploy/helm/agentrun`: `helm install agentrun deploy/helm/agentrun` runs the release's image as one pod on a 10 GiB volume, with the token and seal key made as a Secret at install and kept on upgrade (or your own, with `existingSecret`). `publicUrl` sets the console's address and `ingress.enabled` adds an Ingress. Agents get file tools and `web_fetch`, no shell. CI walks it on kind from install to a finished first run, an upgrade and an uninstall (`deploy/helm/walk.sh`).
