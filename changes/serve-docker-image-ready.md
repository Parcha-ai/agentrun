---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A server with the Docker box makes its image ready at its start, so a sandbox run's first tool call is never a silent pull. The default image is the server's own, `agentrun-box`: python 3.12 (`python:3.12-slim`, pinned by its digest) with git, curl, node and rg (Debian's `nodejs` and `ripgrep`), about 300 MB, built from a recipe in the package on first use, tagged and labelled (`agentrun.box-image`) with the recipe's hash, and built again only when the recipe changes. `AGENTRUN_DOCKER_IMAGE` names another image instead, which the server pulls when Docker has none. The build or pull runs once, in the background, for at most 10 minutes. The build reaches the network; a box never does.
- Each box in `GET /v2/capabilities`' `places.boxes` has a `state`: `ready`, `preparing` (available while the image is built or pulled, its `reason` `building the box image (python, git, curl, node, rg)` or `pulling <image>`) or `unavailable`, with the reason.
- A sandbox run whose first box comes while the image is coming waits for it, with one timeline row (`Preparing the box image: building it (python, git, curl, node, rg)…`, or `pulling <image>…`), then goes on. Its box is made once the image is in.
- A build or pull that fails, or takes too long, makes the box unavailable with a reason that names the kind of failure and the next step, and holds none of Docker's output. A run that was waiting fails its call with that reason, and the next sandbox run is `409 agent_not_runnable`. A restart tries again.
- The log has `event=box_image` lines: the image's state at the start, and again when a build or pull ends, with how long it took.
- `@parcha/pi-durable-agent/timeline` exports `HOST_PHASE` (`agentrun.phase`): an entry a host writes with a `summary` shows as one `phase` row with it, no request and no cost.
