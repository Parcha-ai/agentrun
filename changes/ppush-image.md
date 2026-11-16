---
packages: @parcha/agentrun-computer
kind: feature
---
The box image's build is `box/install.sh`, POSIX shell run as root on the Dockerfile's base with `agentrun-archil` beside it, so a vendor that builds images in its own account (a snapshot, a blueprint, a template) runs the same steps the Dockerfile does: boot the base, run `install.sh`, snapshot. The Dockerfile now only copies the two files and runs it, and a second run on the same machine ends the same. The recipe's hash covers `install.sh`, so this is a new box image (`agentrun-box-<hash>`, the E2B template and the Daytona snapshot of the new hash). The `prepareImage` contract is written down in `spec/computer/provider.md` and `PROVIDERS.md`, with a worked example, and the Core conformance case `provider.prepare-image` calls `prepareImage` twice in one run: both answer the same image, and the second is told no `onWait`. A provider with no `prepareImage` passes it, observed.

Breaking: the box Dockerfile takes no build arguments; the archil client's version and sums are pinned in `install.sh`.
