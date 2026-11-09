# AgentRun's one image, the server and its runners, built from a checkout of this repository (from its root):
#   docker build -f packages/serve/docker/Dockerfile -t agentrun-server .
# One image for both, so a runner always knows the schema of the store its server set up. The default command is the
# server with one runner beside it; with runners of their own, the server takes --no-runner and each runner is the same
# image given `runner --data /data --name <name> [--loops N]` (deploy/README.md, and deploy/compose.yaml for a server and
# two runners on one store). Everything they keep is under /data: mount one volume there, the same one in each.
# The base is pinned by digest (a multi-arch index); the dependencies by the workspace's package-lock.json, dev ones
# included: the pi packages the server loads are the workspace's development dependencies, peers of its packages.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
WORKDIR /src
COPY . .
# The console (apps/console, its own lockfile) builds first, so the server's build copies it into its dist; then its
# sources and dependencies go: the image keeps the built files alone.
# The coding-agent CLIs the adapters develop against (dev dependencies, so npm ci installs them) are removed from the
# image after the workspace build: the Claude Agent SDK with its platform packages (they hold the Claude CLI) and the
# Codex CLI with its platform packages (they hold its binary), with their bin links. Each installs itself on first use
# into the data's harnesses (src/harness-install.ts): docker/image-check.sh names them. Never `npm prune --omit=dev`:
# the pi packages the server loads are dev dependencies too.
# Go, for the computer daemon (computerd) alone: built for both architectures after the workspace, into the computer
# package's dist, where a computer finds it. The toolchain stays in this stage; GOTOOLCHAIN=local fetches no other.
COPY --from=golang:1.24.13-trixie@sha256:5835f052b784aa39f2fe9070def3568605c8bc3fcd810f10402066348b61e716 /usr/local/go /usr/local/go
RUN npm ci --ignore-scripts && (cd apps/console && npm ci --ignore-scripts && npm run build) \
 && npm run build && test -f packages/serve/dist/console/index.html && rm -rf apps \
 && PATH="/usr/local/go/bin:$PATH" GOTOOLCHAIN=local GOCACHE=/tmp/go-build GOPATH=/tmp/go npm run build:daemon -w @parcha/agentrun-computer \
 && test -x packages/computer/dist/computerd-linux-amd64 && test -x packages/computer/dist/computerd-linux-arm64 \
 && rm -rf /tmp/go-build /tmp/go \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk-* \
      node_modules/@anthropic-ai/claude-code node_modules/.bin/claude \
      node_modules/@openai/codex node_modules/@openai/codex-* node_modules/.bin/codex \
 && chmod -R a+rX,go-w /src

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
# tini is PID 1, so the run processes the server starts are reaped and get its SIGTERM. git is for an agent's learning
# folder, which needs 2.32 or newer; this image holds itself to 2.40 by its own choice: trixie's is 2.47. docker-cli (26.1) is the Docker client alone, no daemon:
# with the host's Docker socket mounted (compose.yaml at the repository's root), a run's Docker box is a container beside this one.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tini git docker-cli >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0700 /data
RUN v="$(git --version | cut -d' ' -f3)" && dpkg --compare-versions "$v" ge 2.40 \
 || { echo "git $v is older than 2.40" >&2; exit 1; }
COPY --from=build --chown=root:root /src /opt/agentrun
# The build fails if any of it is left anywhere in the tree, a nested copy included, or if the Codex CLI the tree holds
# is not the build its adapter is pinned to.
RUN sh /opt/agentrun/packages/serve/docker/image-check.sh /opt/agentrun
WORKDIR /opt/agentrun
USER node
ENV NODE_ENV=production
EXPOSE 7340
VOLUME ["/data"]
ENTRYPOINT ["/opt/agentrun/packages/serve/launcher/agentrun-serve", "--", "/usr/bin/tini", "--", "node", "/opt/agentrun/packages/serve/dist/cli.js"]
# A busy run gets 6 s to finish its turn on SIGTERM, so a stop (about 1.5 s more) ends inside Docker's default 10 s
# grace; a turn cut off resumes at the next start.
CMD ["--data", "/data", "--listen", "0.0.0.0", "--port", "7340", "--drain-timeout", "6s"]
