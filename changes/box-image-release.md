---
packages: @parcha/agentrun-computer
kind: feature
---
The box image is published with each release: `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` and `:<release tag>`, for linux/amd64, with an SBOM and max provenance, built once per recipe. From it the release builds the E2B template `agentrun-archil-<recipe hash>` and makes it public, so an E2B team starts an Archil computer from it with nothing built. `box/recipe.mjs` names the recipe's files and prints its hash; `box/build-e2b.mjs` takes `--image <ref>` to build from the published image and `--public` to make the template public.
