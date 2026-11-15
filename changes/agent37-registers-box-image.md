---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
Agent37 starts from our public box image in any account. Its provider's `prepareImage()` reads the workspace template `agentrun-box-<recipe hash>` and, when the workspace has none, registers `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` under that name (`POST /v1/templates`, no build). The wait is reported to `onWait` as a pull, so a run's first claim says it is pulling, once per workspace. A refusal is the run's error in Agent37's words.
- In Mode 2, an Agent37 sandbox and an Agent37 desktop are ready once the keys work: they mount the run's folder from the owner's Archil disk, on the image they register. A Modal or E2B sandbox and an E2B desktop are still refused.
- A desktop that mounts the run's folder starts the `shell` group's commands and the programs `processes.start` opens in `/workspace`, as `bash` does.
- Serve's default sandbox image (`AGENTRUN_DOCKER_IMAGE`) and its refusal of a desktop with no image are Docker's alone. A provider that prepares its image gets no image from them.
- Breaking: `AGENT37_BOX_TEMPLATE` is gone from `@parcha/agentrun-computer`, and Agent37's descriptor has no `defaultImage`. The box template's name carries the recipe's hash; ask the provider's `prepareImage()` for it.
- Breaking: `box/build-agent37.mjs` is gone from the package. Agent37 never builds the box: `prepareImage()` registers the published image.
