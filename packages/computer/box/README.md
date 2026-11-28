# The box image

The image a remote computer with an Archil mount starts from: a small Debian with a coding agent's tools, the archil
client pinned by version and sha256, the root helper `agentrun-archil`, the tool user `agentrun-tool` (uid and gid
2510), FUSE and nftables, a desktop with nothing started (Xvfb, xfwm4 and the apps an agent opens), and no sudo. One
image serves a sandbox and a desktop. The Dockerfile's comment says what each part is for.

Every step of the build is `install.sh`, POSIX shell run as root on the Dockerfile's base (`python:3.12-slim`), with
`agentrun-archil` beside it. The Dockerfile only copies the two and runs it. A vendor that builds images in its own
account from a running machine (a snapshot, a blueprint, a template) boots that base, copies both files into one folder,
runs `sh install.sh` as root and snapshots the result. A second run on the same machine ends the same.

A vendor whose base is Ubuntu 24.04 runs the same `install.sh`. Ubuntu has no `firefox-esr` (its `firefox` is a snap),
so where `apt-cache policy firefox-esr` reads no candidate, the desktop step adds Mozilla's APT repository first: its
signing key fetched over https and refused unless the file holds that one key, fingerprint
`35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3`; a pin in `/etc/apt/preferences.d/mozilla` that lets
`packages.mozilla.org` supply `firefox-esr` and its `firefox-esr-*` packages and puts everything else from it at -1,
so it never replaces a package of the base's; and the source, signed by that key alone. A base whose apt has
`firefox-esr` (Debian's) keeps its own package and never reaches Mozilla.

The image also serves a vendor that boots it with env but has no exec stream into it: the machine dials the server
(`spec/computer/attach.md`). `install.sh` writes `agentrun-dial` to `/usr/local/bin`, root's, 0755, and the
Dockerfile's `CMD` runs it when the provider's create set `AGENTRUN_ATTACH_URL`, and `sleep infinity` otherwise, so
one image serves both. It fetches the server's `computerd` with the machine's token (`AGENTRUN_DAEMON_URL`), checks it
against `AGENTRUN_DAEMON_SHA256` before anything runs, starts `computerd init $AGENTRUN_INIT_ARGS` in a clean
environment, and becomes `computerd attach` with `AGENTRUN_ATTACH_URL` and `AGENTRUN_ATTACH_TOKEN` alone in its
environment. A vendor whose own entrypoint must stay the machine's first process runs `agentrun-dial` from it.

Its tag is the recipe's hash: the first 12 hex of the sha256 of `Dockerfile`, `install.sh` and `agentrun-archil`, the
files it copies (`recipe.mjs`). A changed recipe is a new image, and the same recipe is the one built before.

Each release publishes it (`.github/workflows/release.yml`, the `box` job) as `ghcr.io/parcha-ai/agentrun-box:<recipe hash>`
and `:<release tag>`, for linux/amd64, and builds the public E2B template `agentrun-archil-<recipe hash>` from it in the
same job, which E2B's provider starts in any account as `boxE2bTemplate()` (`src/box-image.ts`). The build-*
scripts here say how to build it for each provider. `build-daytona.py --documents` builds it with the documents layer
on top (`../documents/documents.sh`, the libraries that write Office files, which the Docker box's documents image runs
too) as a snapshot of its own, `agentrun-documents-<hash>`, the hash covering this recipe and that layer: this recipe's
hash, and the snapshot named by it, stay as they are.
