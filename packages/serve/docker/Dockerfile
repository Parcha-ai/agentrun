# AgentRun Server in one container, built from a checkout of this repository (from its root):
#   docker build -f packages/serve/docker/Dockerfile -t agentrun-server .
# Everything it keeps is under /data: store.sqlite and runs/. Mount a volume there.
# The base is pinned by digest (a multi-arch index); the dependencies by the workspace's package-lock.json, dev ones
# included: the pi packages the server loads are the workspace's development dependencies, peers of its packages.
FROM node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS build
WORKDIR /src
COPY . .
# The reference harness is not part of the server: it is removed from the image after the workspace build. So is the
# Claude Agent SDK, which its adapter develops against (a dev dependency, so npm ci installs it), with its platform
# packages (they hold the Claude CLI) and bin link, until its licence is reviewed for the image: docker/image-check.sh
# names them. Never `npm prune --omit=dev`: the pi packages the server loads are dev dependencies too.
# The console (apps/console, its own lockfile) builds first: serve's build copies its dist into packages/serve/dist/console,
# and its node_modules are not part of the image.
RUN npm ci --ignore-scripts --prefix apps/console && npm run build --prefix apps/console \
 && npm ci --ignore-scripts && npm run build \
 && rm -rf apps/console/node_modules apps/console/dist \
 && rm -rf packages/harness node_modules/@parcha/agentrun-harness \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk-* \
      node_modules/@anthropic-ai/claude-code node_modules/.bin/claude \
 && chmod -R a+rX,go-w /src

FROM node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6
# tini is PID 1, so the run processes the server starts are reaped and get its SIGTERM. git is for pi-git-remote, which
# needs 2.40 or newer: trixie's is 2.47 (bookworm's was 2.39).
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tini git >/dev/null \
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
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agentrun/packages/serve/dist/cli.js"]
# A busy run gets 6 s to finish its turn on SIGTERM, so a stop (about 1.5 s more) ends inside Docker's default 10 s
# grace; a turn cut off resumes at the next start.
CMD ["--data", "/data", "--listen", "0.0.0.0", "--port", "7340", "--drain-timeout", "6s"]
