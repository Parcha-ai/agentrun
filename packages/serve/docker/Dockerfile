# AgentRun Server in one container, built from a checkout of this repository (from its root):
#   docker build -f packages/serve/docker/Dockerfile -t agentrun-server .
# Everything it keeps is under /data: store.sqlite and runs/. Mount a volume there.
# The base is pinned by digest (a multi-arch index); the dependencies by the workspace's package-lock.json, dev ones
# included: the pi packages the server loads are the workspace's development dependencies, peers of its packages.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /src
COPY . .
# The reference harness is not part of the server: it is removed from the image after the workspace build.
RUN npm ci --ignore-scripts && npm run build \
 && rm -rf packages/harness node_modules/@parcha/agentrun-harness \
 && chmod -R a+rX,go-w /src

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
# tini is PID 1, so the run processes the server starts are reaped and get its SIGTERM.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tini >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0700 /data
COPY --from=build --chown=root:root /src /opt/agentrun
WORKDIR /opt/agentrun
USER node
ENV NODE_ENV=production
EXPOSE 7340
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agentrun/packages/serve/dist/cli.js"]
# A busy run gets 6 s to finish its turn on SIGTERM, so a stop (about 1.5 s more) ends inside Docker's default 10 s
# grace; a turn cut off resumes at the next start.
CMD ["--data", "/data", "--listen", "0.0.0.0", "--port", "7340", "--drain-timeout", "6s"]
