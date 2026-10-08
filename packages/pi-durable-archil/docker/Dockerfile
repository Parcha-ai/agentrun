# pi-durable-archil in one container: the Linux box an instance of a run needs, on any Docker host (Docker Desktop,
# OrbStack, Colima, Linux). The container is the instance's cage: it runs as root inside, mounts the run's directory
# through FUSE, and runs the agent's commands as the unprivileged user `pda` (uid 1500) under no_new_privs. The host
# driver (`supervise --host docker`) starts one container per instance; nothing on the host needs root or sudo.
#
# Build from this directory of a checkout, after the workspace's `npm ci` (the quickstart does this):
#   npm pack --pack-destination docker/package && docker build -f docker/Dockerfile -t pi-durable-archil:local .
# Build from npm (no tarball in docker/package): the release of this checkout's package.json version, or PDA_VERSION
# (a version, or a dist-tag such as beta, only when asked for):
#   docker build -f docker/Dockerfile -t pi-durable-archil:local .
# The package inside an image is always one version: the tarball's must be this checkout's (or PDA_VERSION). A release
# that predates the Docker path is refused: between releases, build from the checkout (docker/package/README.md).
#
# Pinned: the Node base by digest (a multi-arch index), the archil client 0.8.42 by sha256 per architecture, the
# runtime dependencies by docker/runtime/package-lock.json. No secret is in any layer: the mount token reaches a
# container only after `docker create`, as a file the entrypoint removes before the instance starts.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG ARCHIL_VERSION=0.8.42-1790378297
ARG ARCHIL_SHA256_AMD64=ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3
ARG ARCHIL_SHA256_ARM64=2219d6e84decf37041e7a299d0477edda8770fb960b2a0ba349059ad3a3bc1f3

# FUSE (libfuse2 for the client, fuse3 for fusermount), tini as PID 1, the archil client checked by hash, the run user.
# Node's own fetch downloads the client, so no curl stays in the image.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum="$ARCHIL_SHA256_AMD64" ;; \
      arm64) sum="$ARCHIL_SHA256_ARM64" ;; \
      *) echo "no archil client for $arch" >&2; exit 1 ;; \
    esac; \
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require("node:fs").writeFileSync("/tmp/archil.deb", Buffer.from(await r.arrayBuffer())); })' \
      "https://s3.amazonaws.com/archil-client/pkg/archil_${ARCHIL_VERSION}_${arch}.deb"; \
    echo "$sum  /tmp/archil.deb" | sha256sum -c -; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates libfuse2 fuse3 tini /tmp/archil.deb >/dev/null; \
    rm -rf /var/lib/apt/lists/* /tmp/archil.deb; \
    groupadd --gid 1500 pda; \
    useradd --uid 1500 --gid 1500 --create-home --home-dir /home/pda --shell /bin/bash pda; \
    install -d -m 0755 /mnt/archil /opt/pda /opt/pda/app; \
    install -d -m 0700 /run/pda; \
    archil --version | head -1

# The runtime dependencies (pi-durable, chord, pi-ai, the disk SDK) from the lockfile.
COPY docker/runtime/package.json docker/runtime/package-lock.json /opt/pda/
RUN cd /opt/pda && npm ci --omit=dev --no-audit --no-fund --loglevel=error --cache /tmp/npm-cache && rm -rf /tmp/npm-cache

# The package itself: a tarball in docker/package (a checkout's `npm pack`), else the release from npm. Either way the
# version is this checkout's package.json version unless PDA_VERSION names another; no floating default.
ARG PDA_VERSION=
COPY package.json /tmp/pda-package.json
COPY docker/package/ /tmp/pda-package/
COPY docker/entrypoint.sh /usr/local/bin/pda-entrypoint
RUN set -eu; \
    want="${PDA_VERSION:-$(node -p 'require("/tmp/pda-package.json").version')}"; \
    cd /tmp/pda-package; \
    set -- parcha-pi-durable-archil-*.tgz; \
    if [ "$#" -gt 1 ]; then echo "docker/package holds $# tarballs ($*); keep one" >&2; exit 1; fi; \
    if [ -e "$1" ]; then \
      tgz="$1"; \
      [ "$tgz" = "parcha-pi-durable-archil-$want.tgz" ] || { echo "docker/package/$tgz is not version $want (this checkout's, or PDA_VERSION): pack this checkout again, or remove it to build from npm" >&2; exit 1; }; \
    else \
      npm pack --cache /tmp/npm-cache --loglevel=silent "@parcha/pi-durable-archil@$want" >/dev/null \
        || { echo "npm pack @parcha/pi-durable-archil@$want failed (not published, or npm unreachable): build from a checkout with npm pack (docker/package/README.md), or set PDA_VERSION" >&2; exit 1; }; \
      set -- parcha-pi-durable-archil-*.tgz; tgz="$1"; \
    fi; \
    echo "@parcha/pi-durable-archil from $tgz"; \
    install -d /opt/pda/node_modules/@parcha/pi-durable-archil; \
    tar -xzf "$tgz" -C /opt/pda/node_modules/@parcha/pi-durable-archil --strip-components=1 --no-same-owner; \
    [ -f /opt/pda/node_modules/@parcha/pi-durable-archil/dist/hosts/docker.js ] \
      || { echo "@parcha/pi-durable-archil from $tgz predates the Docker path: build from a checkout with npm pack (docker/package/README.md), or set PDA_VERSION to a later release" >&2; exit 1; }; \
    rm -rf /tmp/pda-package /tmp/pda-package.json /tmp/npm-cache; \
    install -o root -g root -m 0755 /opt/pda/node_modules/@parcha/pi-durable-archil/bin/archil-scoped /usr/local/sbin/archil-scoped; \
    chmod 0755 /usr/local/bin/pda-entrypoint; \
    ln -s /opt/pda/node_modules/@parcha/pi-durable-archil/dist/cli.js /usr/local/bin/pi-durable-archil; \
    chown -R root:root /opt/pda; \
    chmod -R a+rX,go-w /opt/pda; \
    node /opt/pda/node_modules/@parcha/pi-durable-archil/dist/cli.js 2>&1 | head -1 || true

LABEL org.opencontainers.image.title="pi-durable-archil" \
      org.opencontainers.image.description="A pi-durable instance on an Archil disk: one container per instance, FUSE inside, commands as an unprivileged user" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pda-entrypoint"]
CMD ["--help"]
