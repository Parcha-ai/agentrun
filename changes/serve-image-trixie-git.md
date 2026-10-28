---
packages: @parcha/agentrun-serve
kind: feature
---
**AgentRun Server's image has git, on Debian trixie**
- `packages/serve/docker/Dockerfile` builds both stages on `node:22.23.2-trixie-slim`, pinned by its multi-arch index digest as before, and the runtime installs `git` (2.47) next to `tini`. `pi-git-remote` needs git 2.40 or newer; bookworm's is 2.39, and the bookworm image had no git at all. The build fails if the git it installs is older than 2.40.
- The base moves from Debian 12 (bookworm, glibc 2.36) to Debian 13 (trixie, glibc 2.41). Node's version is still 22.23.2, but its binary is the trixie build. An image built `FROM` this one gets trixie's packages and glibc: whatever it adds with apt or compiles must suit trixie. A native addon built against glibc 2.41 does not load on bookworm.
- git and its Debian dependencies (perl among them) add about 36 MB to the compressed image (181 MB to 217 MB) and about 100 MB unpacked.
