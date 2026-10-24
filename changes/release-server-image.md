---
packages: repo
kind: ci
---
The release workflow builds AgentRun Server's container image from the reviewed tag once publication passes, and pushes `ghcr.io/parcha-ai/agentrun-server:<tag>` and `:beta` for linux/amd64 and linux/arm64, with an SBOM and max provenance stored with the image.
