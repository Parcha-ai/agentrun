---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
The box image and the default Docker image run Node.js 24.22.3 with its own npm, the release serve's image runs, in place of Debian's nodejs and npm 9: each unpacks the release's tarball into `/usr/local` after checking it against its sha256 for the host's architecture (`DOCKER_NODE_VERSION`, `DOCKER_NODE_SHA256`). The box recipe's hash moves to `243c3c1a9d57`, so the next release publishes `ghcr.io/parcha-ai/agentrun-box:243c3c1a9d57` and its E2B template, a Daytona box snapshot is built again as `agentrun-box-243c3c1a9d57`, and the relay's pinned recipe hash changes with it (`relays/cloudflare/wrangler.json`, redeploy the relay). A Docker host builds the default image once more at its next computer.
A Docker computer's egress proxy takes a cap on the connections it holds open at once: `egress.maxTunnels` (a whole number from 1 to 256, default 64; past the cap a new connection is answered 429), passed as the proxy's `--max-tunnels` and read back as made. serve sets it from `AGENTRUN_BOX_MAX_TUNNELS`, listed with the start-time switches; any other value stops the start, in words naming the setting.
