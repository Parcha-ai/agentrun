---
packages: @parcha/agentrun-computer
kind: ci
---
Each release now publishes the media box image (`packages/computer/media/Dockerfile`) for linux/amd64 as `ghcr.io/parcha-ai/agentrun-media:<hash>`, the first 12 hex digits of the Dockerfile's sha256, and tags it with the release. A new `media` job, under the release's `npm-release` approval, builds it once per Dockerfile, reads no secret, and stops in words when the package is not public. Name it in `AGENTRUN_DOCKER_IMAGE` and Docker pulls it; on arm64, build it from the Dockerfile as before.
