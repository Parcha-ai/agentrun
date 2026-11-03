---
packages: @parcha/agentrun-serve
kind: docs
---
The serve README has a sandbox in 60 seconds near its top: pull the box's image, start the server with `AGENTRUN_BOXES=docker`, make an agent whose place is a Docker box with `bash`, `write` and `read`, run it, watch its timeline, and read the file it wrote from `GET /v2/runs/{id}/files`, with a no-key variant on a three-line faux model. The root README points to it.
- The sandbox text is one section: the place, the boxes, a run in a Docker box, the box's image and the published image, where it was spread over about 490 lines.
- `AGENTRUN_DOCKER_IMAGE` has its own part: the default `debian:bookworm-slim` has no python or git, and a box has no network, so it says how to pick or build an image that has them.
- It says plainly that the published image cannot host boxes yet (no docker command, no daemon), and why mounting the host's Docker socket into it is no way around that.
- The tools table lists `bash`, and the places that still said a run has no shell (the tools, a run's life, safety) say it runs only in a box.
