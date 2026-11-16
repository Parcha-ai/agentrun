# The box image

The image a remote computer with an Archil mount starts from: a small Debian with a coding agent's tools, the archil
client pinned by version and sha256, the root helper `agentrun-archil`, the tool user `agentrun-tool` (uid and gid
2510), FUSE and nftables, a desktop with nothing started (Xvfb, xfwm4 and the apps an agent opens), and no sudo. One
image serves a sandbox and a desktop. The Dockerfile's comment says what each part is for.

Every step of the build is `install.sh`, POSIX shell run as root on the Dockerfile's base (`python:3.12-slim`), with
`agentrun-archil` beside it. The Dockerfile only copies the two and runs it. A vendor that builds images in its own
account from a running machine (a snapshot, a blueprint, a template) boots that base, copies both files into one folder,
runs `sh install.sh` as root and snapshots the result. A second run on the same machine ends the same. A vendor that
pulls a registry image, or needs its own agent in the image, builds `vendorDockerfile(base, { agent, start })` from
`recipe.mjs`: the box image on its base, its agent added before `install.sh` runs, its entrypoint kept. Any base must
be Debian; `install.sh` refuses another in words.

Its tag is the recipe's hash: the first 12 hex of the sha256 of `Dockerfile`, `install.sh` and `agentrun-archil`, the
files it copies (`recipe.mjs`). A changed recipe is a new image, and the same recipe is the one built before.

Each release publishes it (`.github/workflows/release.yml`, the `box` job) as `ghcr.io/parcha-ai/agentrun-box:<recipe hash>`
and `:<release tag>`, for linux/amd64, and builds the public E2B template `agentrun-archil-<recipe hash>` from it (the
`box-e2b` job), which E2B's provider starts in any account as `boxE2bTemplate()` (`src/box-image.ts`). The build-*
scripts here say how to build it for each provider.
