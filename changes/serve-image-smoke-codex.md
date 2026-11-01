---
packages: @parcha/agentrun-serve
kind: feature
---
`docker/image-smoke.sh` now checks codex. A built image must list it in `GET /v2/capabilities`. Because the image carries the pinned Codex CLI, codex is never unavailable as not installed or not the pinned build. It is available, or unavailable for a setting its reason names, such as `OPENAI_API_KEY`. Set `IMAGE_SMOKE_CODEX=available` on a run that is given a model key, and codex must then be available.
- A new test covers what the server offers of codex. It is available on the pinned build with a model key, unavailable for the key it names without one, and unavailable as not the pinned build, with the install line, when the binary is any other build.
