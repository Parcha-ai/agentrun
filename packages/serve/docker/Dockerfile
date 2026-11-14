# AgentRun's one image, the server and its runners, built from a checkout of this repository (from its root):
#   docker build -f packages/serve/docker/Dockerfile -t agentrun-server .
# One image for both, so a runner always knows the schema of the store its server set up. The default command is the
# server with one runner beside it; with runners of their own, the server takes --no-runner and each runner is the same
# image given `runner --data /data --name <name> [--loops N]` (deploy/README.md, and deploy/compose.yaml for a server and
# two runners on one store). Everything they keep is under /data: mount one volume there, the same one in each.
# The base is pinned by digest (a multi-arch index); the dependencies by the workspace's package-lock.json, dev ones
# included: the pi packages the server loads are the workspace's development dependencies, peers of its packages.
# Node is 24.22.3, Node's November 2026 security release, installed from nodejs.org by install-node.sh, which verifies
# the release's signed checksums: the official node:24.22.3 image was not yet published for amd64 and arm64 when this
# was pinned. The base is plain Debian trixie, so no other Node is in any layer. Moves back to the official node image
# next release.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS node
ARG TARGETARCH
# The key that signed this release's SHASUMS256.txt, by fingerprint, read from nodejs/release-keys at a pinned commit.
ARG NODE_VERSION=24.22.3
ARG NODE_SIGNER=5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
ARG NODE_RELEASE_KEYS=481637f813e912c4aa3622d7964ab426c97b8e8d
COPY packages/serve/docker/install-node.sh /usr/local/sbin/install-node.sh
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg xz-utils >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && sh /usr/local/sbin/install-node.sh "$NODE_VERSION" "$NODE_SIGNER" "$NODE_RELEASE_KEYS" /opt/node

# The Android SDK files phoned's build reads, at the pin of packages/computer/scripts/android-sdk.mjs: the platform's
# android.jar and core-for-system-modules.jar (platforms;android-35, r02), and d8 (build-tools;35.0.0), a jar the JDK
# runs on either architecture. Each zip from Google pinned by sha256; the JDK's jar takes the three files out, so no
# unzip is installed and nothing else of them is kept. The JDK is Eclipse Temurin 17's, pinned by digest (a multi-arch
# index), as the build stage takes it.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS android
COPY --from=eclipse-temurin:17.0.21_9-jdk@sha256:5465815640e10433422217335e15a523a3e57021a1f2ae0fc3849380d237979f /opt/java/openjdk /opt/jdk-17
ADD --checksum=sha256:0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0 https://dl.google.com/android/repository/platform-35_r02.zip /tmp/platform.zip
ADD --checksum=sha256:bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88 https://dl.google.com/android/repository/build-tools_r35_linux.zip /tmp/build-tools.zip
RUN install -d /tmp/x /opt/android-sdk/platforms /opt/android-sdk/build-tools/35.0.0/lib && cd /tmp/x \
 && /opt/jdk-17/bin/jar xf /tmp/platform.zip android-35/android.jar android-35/core-for-system-modules.jar \
 && /opt/jdk-17/bin/jar xf /tmp/build-tools.zip android-15/lib/d8.jar \
 && mv android-35 /opt/android-sdk/platforms/android-35 \
 && mv android-15/lib/d8.jar /opt/android-sdk/build-tools/35.0.0/lib/d8.jar \
 && rm -rf /tmp/x /tmp/platform.zip /tmp/build-tools.zip

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS build
COPY --from=node /opt/node/ /usr/local/
RUN [ "$(node --version)" = v24.22.3 ]
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
# A JDK 17 and the Android SDK's files (the android stage), for phoned, the phone's driver (dist/phoned.jar), which the
# phone provider pushes to each phone: built after the daemon, the same way. Both stay in this stage.
COPY --from=android /opt/jdk-17 /opt/jdk-17
COPY --from=android /opt/android-sdk /opt/android-sdk
RUN npm ci --ignore-scripts && (cd apps/console && npm ci --ignore-scripts && npm run build) \
 && npm run build && test -f packages/serve/dist/console/index.html && rm -rf apps \
 && PATH="/usr/local/go/bin:$PATH" GOTOOLCHAIN=local GOCACHE=/tmp/go-build GOPATH=/tmp/go npm run build:daemon -w @parcha/agentrun-computer \
 && test -x packages/computer/dist/computerd-linux-amd64 && test -x packages/computer/dist/computerd-linux-arm64 \
 && rm -rf /tmp/go-build /tmp/go \
 && JAVA_HOME=/opt/jdk-17 ANDROID_HOME=/opt/android-sdk npm run build:phoned -w @parcha/agentrun-computer \
 && npm run check:phoned -w @parcha/agentrun-computer \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk-* \
      node_modules/@anthropic-ai/claude-code node_modules/.bin/claude \
      node_modules/@openai/codex node_modules/@openai/codex-* node_modules/.bin/codex \
 && chmod -R a+rX,go-w /src

# adb (Android platform-tools), which the phone provider drives its phone with from this machine: r35.0.2, its zip
# pinned by sha256. Google builds platform-tools for x86-64 Linux alone, so the arm64 image carries no adb, and the
# server says so in Settings → Computers ("this server's image has no adb for arm64 (…): Phone harness needs an x86-64
# server"). It needs only the C library.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS adb
ARG TARGETARCH
ARG PLATFORM_TOOLS_ZIP=https://dl.google.com/android/repository/platform-tools_r35.0.2-linux.zip
ARG PLATFORM_TOOLS_SHA256=acfdcccb123a8718c46c46c059b2f621140194e5ec1ac9d81715be3d6ab6cd0a
RUN install -d /opt/adb \
 && if [ "$TARGETARCH" = amd64 ]; then \
      apt-get update -qq \
      && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl unzip >/dev/null \
      && curl -fsSL -o /tmp/platform-tools.zip "$PLATFORM_TOOLS_ZIP" \
      && echo "$PLATFORM_TOOLS_SHA256  /tmp/platform-tools.zip" | sha256sum -c - \
      && unzip -q -j /tmp/platform-tools.zip platform-tools/adb -d /opt/adb \
      && /opt/adb/adb version | grep -q '^Version 35\.0\.2-'; \
    fi

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=node /opt/node/ /usr/local/
# The node user (1000:1000) the official node image has, which the server runs as and /data belongs to.
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
# tini is PID 1, so the run processes the server starts are reaped and get its SIGTERM. git is for an agent's learning
# folder, which needs 2.32 or newer; this image holds itself to 2.40 by its own choice: trixie's is 2.47. docker-cli (26.1) is the Docker client alone, no daemon:
# with the host's Docker socket mounted (compose.yaml at the repository's root), a run's Docker box is a container beside this one.
# ca-certificates: git's HTTPS (a run's pull request checkout, runner/pr-checkout.ts) trusts nothing without them, and the
# slim base purges them.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tini git ca-certificates docker-cli >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0700 /data
RUN v="$(git --version | cut -d' ' -f3)" && dpkg --compare-versions "$v" ge 2.40 \
 || { echo "git $v is older than 2.40" >&2; exit 1; }
COPY --from=build --chown=root:root /src /opt/agentrun
# The build fails if any of it is left anywhere in the tree, a nested copy included, or if the Codex CLI the tree holds
# is not the build its adapter is pinned to.
RUN sh /opt/agentrun/packages/serve/docker/image-check.sh /opt/agentrun
# One Node in the image, the verified 24.22.3: the build fails on any other executable named node.
RUN [ "$(node --version)" = v24.22.3 ] && [ "$(command -v node)" = /usr/local/bin/node ] \
 && other="$(find / -xdev -type f -name node ! -path /usr/local/bin/node -print)" \
 && { [ -z "$other" ] || { printf 'another node binary in the image:\n%s\n' "$other" >&2; exit 1; }; }
# The package's own command on PATH, so the words the console and the CLI give work in the image's shell as written
# (`agentrun-serve reset-password --data /data`, on Render's Shell too). The launcher finds dist/cli.js beside itself through
# its real path, so a link to it runs the same server CLI.
RUN ln -s /opt/agentrun/packages/serve/launcher/agentrun-serve /usr/local/bin/agentrun-serve \
 && [ "$(command -v agentrun-serve)" = /usr/local/bin/agentrun-serve ]
# The phone provider's adb on PATH, on amd64 (the adb stage); the arm64 image has none.
COPY --from=adb /opt/adb/ /usr/local/bin/
RUN [ "$(dpkg --print-architecture)" != amd64 ] || [ "$(command -v adb)" = /usr/local/bin/adb ]
WORKDIR /opt/agentrun
USER node
ENV NODE_ENV=production
EXPOSE 7340
VOLUME ["/data"]
ENTRYPOINT ["/opt/agentrun/packages/serve/launcher/agentrun-serve", "--", "/usr/bin/tini", "--", "node", "/opt/agentrun/packages/serve/dist/cli.js"]
# A busy run gets 6 s to finish its turn on SIGTERM, so a stop (about 1.5 s more) ends inside Docker's default 10 s
# grace; a turn cut off resumes at the next start.
CMD ["--data", "/data", "--listen", "0.0.0.0", "--port", "7340", "--drain-timeout", "6s"]
