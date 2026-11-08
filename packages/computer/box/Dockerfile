# The image a remote computer with an Archil mount starts from: a Daytona snapshot (build-daytona.py), a Modal image
# (build-modal.py), or an E2B template, named by the computer spec's image. It is a small Debian with a coding agent's
# tools, plus what keeps the run's work folder on the owner's Archil disk:
#
#   - the archil client at /usr/bin/archil, 0.10.1 (the version the live checks ran), checked by sha256;
#   - the root helper, this folder's agentrun-archil, at /usr/local/sbin/agentrun-archil, root:root 0755;
#   - the tool user agentrun-tool, uid and gid 2510, which computerd runs every tool as;
#   - FUSE (fuse3, and the client's own FUSE library). No firewall: init and every tool run in a network namespace of
#     their own with loopback alone (computerd init --own-network), while the archil client and serve, as root, stay in
#     the computer's, which reaches Archil;
#   - /workspace, empty and root's, where the helper mounts the run's folder.
#
# No sudo and no sudoers file: the image's user is root, so the provider's own exec (Daytona's toolbox, Modal's exec,
# E2B's commands as root) runs the helper as root, and the tool user has no way to root. The build fails if the base
# brings either. computerd is not part of the image: the provider uploads and installs it, root's alone, at create, and
# the helper's serve runs that one.
#
# /proc with hidepid=2 is not part of an image: the helper remounts /proc so before each mount, as root, and refuses the
# mount in a computer where that fails.
#
# An archil package whose sha256 reads `unpinned` stops the build, saying so: pin both sums before any build.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

ARG ARCHIL_VERSION=0.10.1-1793222256
ARG ARCHIL_SHA256_AMD64=f219e70287e8152f3f0c7222e1c3319f4665897235af7c33a8846e56a5a5786a
ARG ARCHIL_SHA256_ARM64=10ed430e51c268af095dd9e6c7aa6cdbb951d2430d62a76458719db168f40c0e

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum="$ARCHIL_SHA256_AMD64" ;; \
      arm64) sum="$ARCHIL_SHA256_ARM64" ;; \
      *) echo "no archil client for $arch" >&2; exit 1 ;; \
    esac; \
    case "$sum" in unpinned) echo "archil ${ARCHIL_VERSION} for $arch has no pinned sha256 yet: set ARCHIL_SHA256_$(echo "$arch" | tr a-z A-Z) to the package's sum" >&2; exit 1 ;; esac; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      git curl ca-certificates nodejs npm ripgrep fuse3 >/dev/null; \
    curl -fsSL -o /tmp/archil.deb "https://s3.amazonaws.com/archil-client/pkg/archil_${ARCHIL_VERSION}_${arch}.deb"; \
    echo "$sum  /tmp/archil.deb" | sha256sum -c -; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends /tmp/archil.deb >/dev/null; \
    rm -rf /var/lib/apt/lists/* /tmp/archil.deb; \
    groupadd --gid 2510 agentrun-tool; \
    useradd --uid 2510 --gid 2510 --no-create-home --home-dir /tmp --shell /bin/sh agentrun-tool; \
    install -d -o root -g root -m 0755 /workspace

COPY agentrun-archil /usr/local/sbin/agentrun-archil

# What the helper runs, where it runs it from: an image that lacks one fails here, not at a run's first mount. And no
# way to root for the tool user: no sudo, no sudoers.
RUN set -eu; \
    chown root:root /usr/local/sbin/agentrun-archil; \
    chmod 0755 /usr/local/sbin/agentrun-archil; \
    for x in /usr/bin/archil /usr/bin/awk /usr/bin/realpath /usr/bin/mount /usr/bin/chown /usr/bin/id /usr/bin/ls; do \
      [ -x "$x" ] || { echo "the image has no $x" >&2; exit 1; }; \
    done; \
    ! command -v sudo >/dev/null 2>&1 || { echo "the image has sudo" >&2; exit 1; }; \
    [ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo "the image has a sudoers file" >&2; exit 1; }; \
    ids="$(id -u agentrun-tool):$(id -g agentrun-tool)"; \
    [ "$ids" = "2510:2510" ] || { echo "agentrun-tool is $ids" >&2; exit 1; }; \
    archil --version | head -1

USER root
# A computer's first process is its provider's own (Daytona's runs this when a snapshot names no entrypoint; Modal's and
# E2B's are their own): never the base image's python.
CMD ["sleep", "infinity"]
