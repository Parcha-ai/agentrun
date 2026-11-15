---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
Modal starts from our public box image in any account. Its descriptor says `prepareImage`, and its provider's `prepareImage()` answers `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` with no call: Modal pulls the registry tag at a computer's first create in a workspace.
- In Mode 2, a Modal sandbox is ready once the keys work: it mounts the run's folder from the owner's Archil disk, on the box image. A Modal sandbox with GPUs still mounts nothing and is refused in Mode 2, in words.
- A computer on a host with no `extend` (Modal, Daytona) carries no `agentrun.computer.max-deadline` label: `extend` is its only reader, and the bytes go to Modal's 512 for tags.
- Breaking: `MODAL_DEFAULT_IMAGE` is gone from `@parcha/agentrun-computer`, and Modal's descriptor has no `defaultImage`. Ask the provider's `prepareImage()` for its image.
