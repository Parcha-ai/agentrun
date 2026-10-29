---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server's image build now proves the Codex CLI it ships is the pinned build. `docker/image-check.sh` runs `@parcha/agentrun-codex`'s own check on the final image's tree: the platform package's version, the binary's sha256 and the version the binary reports must all be Codex 0.164.0's for the image's platform. A missing binary, a different binary or another release fails the build with the typed error (`CodexNotInstalled` or `CodexPinMismatch` and the pin it names). The pins already cover both platforms the image is built for, linux/amd64 and linux/arm64.
