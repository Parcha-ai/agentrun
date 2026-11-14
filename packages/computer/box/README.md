# The box image

The image a remote computer with an Archil mount starts from: a small Debian with a coding agent's tools, the archil
client pinned by version and sha256, the root helper `agentrun-archil`, the tool user `agentrun-tool` (uid and gid
2510), FUSE and nftables, and no sudo. The Dockerfile's comment says what each part is for.

## The recipe

The image is made of two files, `Dockerfile` and `agentrun-archil`, the one file it copies. `recipe.mjs` names them and
prints their hash, the first 12 hex of their sha256 (`node packages/computer/box/recipe.mjs`). Every build names what it
makes by that hash, so a changed recipe is a new image and the same recipe is the one built before.

`.dockerignore` lets `agentrun-archil` alone into a build's context, Docker's or E2B's; the builder reads the
Dockerfile on its own. The Dockerfile takes no build secret, and its build arguments are the archil client's version
and package sums. `test/box-recipe.test.mjs` fails if this folder gains a file named like a key or a credential, holds
key material, or the Dockerfile takes a secret.

## The published image

Each release publishes it from the reviewed tag (`.github/workflows/release.yml`, after the packages are published and
verified), for linux/amd64, with an SBOM and max provenance:

- `ghcr.io/parcha-ai/agentrun-box:<recipe hash>`, built once per recipe: a release whose recipe is published already
  only tags it;
- `ghcr.io/parcha-ai/agentrun-box:<release tag>`.

From that image, under the same release approval, it builds the E2B template `agentrun-archil-<recipe hash>` and makes
it public (`build-e2b.mjs --image <ref> --public`), so an owner's E2B team starts from it with nothing built. That step
reads the E2B key `E2B_API_KEY` from the `npm-release` environment and stops, saying so, without it. E2B pulls the image
with no credentials, so the step also stops, saying so, while the package is private.

## Building it yourself

| Build | Command | Makes |
| --- | --- | --- |
| Daytona snapshot | `python3 packages/computer/box/build-daytona.py [--gpu H100]` | `agentrun-archil[-gpu-h100]-<hash>` |
| Modal image | `python3 packages/computer/box/build-modal.py [app]` | `im-...` |
| E2B template | `E2B_API_KEY=... node packages/computer/box/build-e2b.mjs [--image <ref>] [--public]` | `agentrun-archil-<hash>` |
| Agent37 template | `AGENT37_API_KEY=... node packages/computer/box/build-agent37.mjs` | `agentrun-box` (the box plus a desktop) |
| Docker | `docker build --platform linux/amd64 packages/computer/box` | the image |
