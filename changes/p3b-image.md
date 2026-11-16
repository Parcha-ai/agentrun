---
packages: @parcha/agentrun-computer
kind: feature
---
The `prepareImage` contract has a Dockerfile path, for a vendor that builds images from a Dockerfile or starts computers from the account's registry (Hyperbrowser's remote builder; Vercel Sandbox from Vercel Container Registry): it builds the box Dockerfile as it is, from the recipe's three files, named by the recipe's hash in the vendor's own form (`agentrun-box-<hash>`, or the tag `agentrun-box:<hash>`), and finds it by that name first, listing the vendor's images where it has no get by name. `spec/computer/provider.md` and `PROVIDERS.md` say how, with a worked example; `provider.prepare-image` covers it unchanged. For a vendor that needs its own base or agent in the image, `vendorDockerfile(base, { agent, start })` in `box/recipe.mjs` writes the box image's Dockerfile on that base. `install.sh` refuses a base that isn't Debian, in words, before it installs anything.

Breaking: `install.sh` changed, so the recipe's hash is new: a new box image, E2B template and Daytona snapshot.
