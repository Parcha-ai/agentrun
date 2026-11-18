---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: feature
---
`curl -fsSL https://agentrun.ai/install | sh -s -- --vps` sets up AgentRun on a Linux server you rent (Ubuntu or Debian, as root), with a shell for its agents in Docker sandboxes. It runs the release's published image (`ghcr.io/parcha-ai/agentrun-server:v<version>`, the server the launcher depends on) with Docker Compose in `/opt/agentrun`, and gives it the server's Docker socket. It prints the address, the setup link with its code, and the line that reads the code again later.
- Docker: one already on the server is used as it is (Docker Engine 26 or later with the compose plugin) and never changed. With none, the installer installs Docker Engine and the compose plugin from Docker's apt repository.
- `/opt/agentrun/.env` (mode 600) holds `AGENTRUN_TOKEN` and `AGENTRUN_SEAL_KEY`, made once with `openssl rand` and kept on every later run, with the lines you add. `compose.yaml` is written again on every run; a `compose.override.yaml` of your own stays. Running it again upgrades to the release it names. `--version V` picks a release and `--image IMAGE` names an image.
- Private by default. With Tailscale logged in, AgentRun is served on your tailnet only, through `tailscale serve` and never Funnel, by the same step as `--tailscale`, run in the server's image. Without Tailscale it listens on the server's loopback, and the installer prints the steps to add Tailscale and exits 0; it never installs Tailscale or logs in. `--public` listens on every address, port 7340, over plain HTTP, and says what that exposes first. If the first visit would not ask for the setup code, the installer stops the server.
- `lib/tailscale.mjs serve` takes the place of the setup code's line as a fifth argument.
- Server: under `--faux`, a server whose own environment names `AGENTRUN_SERVE_FAUX_MOUNTINFO` hands it to the runner it starts beside it, so a test server in a container runs Docker sandboxes as the real one does.
