---
packages: @parcha/agentrun-computer
kind: fix
---
The media image (`packages/computer/media/Dockerfile`) installs its Debian packages from snapshot.debian.org at one instant, the instant its HyperFrames install names in npm's `--before`, instead of from the live mirror, so two builds of one tag install the same Chromium, FFmpeg and fonts. Its tag moves (the recipe's hash), so a server naming the old tag in `AGENTRUN_DOCKER_IMAGE` builds and names the new one. The default image's recipe is unchanged.
