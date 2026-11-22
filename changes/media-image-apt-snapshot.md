---
packages: @parcha/agentrun-computer
kind: fix
---
The media image (`packages/computer/media/Dockerfile`) installs its Debian packages from snapshot.debian.org, over https, at one instant, the instant its HyperFrames install names in npm's `--before`, instead of from the live mirror, so two builds of one tag install the same Chromium, FFmpeg and fonts. Its tag moves (the recipe's hash). The server never builds the media image, so an operator on the old tag rebuilds it, names the new tag in `AGENTRUN_DOCKER_IMAGE` and restarts the server; until then the old image keeps serving. The default image's recipe is unchanged.
