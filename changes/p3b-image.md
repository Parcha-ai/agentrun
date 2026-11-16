---
packages: @parcha/agentrun-computer
kind: feature
---
The `prepareImage` contract has two more paths, both on `box/Dockerfile` as it is: a vendor that takes an image from its own registry gets the box image pushed there under the tag `agentrun-box:<hash>`, and a vendor that builds from a Dockerfile on its side gets `box/Dockerfile` and the rest of the recipe as the build's context, the result named `agentrun-box-<hash>`. Either finds the image by that tag or name before it builds, lists the vendor's images where there's no get by name, waits on one still being made and fails on one whose build failed. `spec/computer/provider.md` and `PROVIDERS.md` say how, with a worked example; `provider.prepare-image` covers both unchanged.
