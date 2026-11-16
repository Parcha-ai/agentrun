---
packages: @parcha/agentrun-computer
kind: feature
---
The `prepareImage` contract has a second path, for a vendor that pulls a registry image or needs its own agent in the image (AWS AgentCore's ECR; Blaxel's and Baseten's sandbox API as the entrypoint): `vendorDockerfile(base, { agent, start })` in `box/recipe.mjs` writes the box image's Dockerfile on the vendor's base, with the agent's lines before `install.sh` runs and the vendor's entrypoint kept, and its `hash` is the tag `prepareImage` pushes it under and finds it by. `spec/computer/provider.md` and `PROVIDERS.md` say how, with a worked example on a fake registry; `provider.prepare-image` covers it unchanged. `install.sh` refuses a base that isn't Debian, in words, before it installs anything.

Breaking: `install.sh` changed, so the recipe's hash is new: a new box image, E2B template and Daytona snapshot.
