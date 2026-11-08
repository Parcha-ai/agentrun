# The image a box on another machine starts from: a Daytona snapshot (AGENTRUN_DAYTONA_SNAPSHOT) or the Modal sandbox's
# image (AGENTRUN_VM_IMAGE). It is the Docker box's base and tools (src/box-image.ts BOX_BASE and BOX_RECIPE, without
# socat, its proxy's relay), plus what keeps the run's work folder on the owner's Archil disk (the README's "A box on
# another machine: the Archil disk"):
#
#   - the archil client at /usr/bin/archil, 0.10.0 (the first with the system CA bundle), checked by sha256;
#   - the root helper, this folder's agentrun-archil, at /usr/local/sbin/agentrun-archil, root:root 0755;
#   - the tool user agentrun-tool (uid 2510), in the shared group (AGENTRUN_ARCHIL_GID, default 2510), with no sudo;
#   - the box's own user daytona, which runs the helper as root and the tools as agentrun-tool, through sudo, and holds
#     no other grant (this folder's sudoers); a box whose user is root needs no line;
#   - iptables and ip6tables (the helper's netlock), FUSE (fuse3, and the client's own FUSE library), sudo, getent;
#   - /workspace, empty, the box user's, where the helper mounts the run's folder.
#
# /proc with hidepid=2 is not part of an image: the helper remounts /proc so before each mount, as root, and refuses the
# mount in a box where that fails (the README says what is known of each provider).
#
# Build it with build-daytona.py or build-modal.py, from this folder.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

ARG ARCHIL_VERSION=0.10.0-1792692895
ARG ARCHIL_SHA256_AMD64=7d75f7b94d64952a939570dc79d0996c914696be176b45e9fed51a45c15ad0ba
ARG ARCHIL_SHA256_ARM64=900e5aa26f63b1e98c697e0de010e34a58802baeb7ec23f539d9d9ba0d137fea
ARG AGENTRUN_ARCHIL_GID=2510

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum="$ARCHIL_SHA256_AMD64" ;; \
      arm64) sum="$ARCHIL_SHA256_ARM64" ;; \
      *) echo "no archil client for $arch" >&2; exit 1 ;; \
    esac; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      git curl ca-certificates nodejs npm ripgrep sudo iptables fuse3 >/dev/null; \
    curl -fsSL -o /tmp/archil.deb "https://s3.amazonaws.com/archil-client/pkg/archil_${ARCHIL_VERSION}_${arch}.deb"; \
    echo "$sum  /tmp/archil.deb" | sha256sum -c -; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends /tmp/archil.deb >/dev/null; \
    rm -rf /var/lib/apt/lists/* /tmp/archil.deb; \
    groupadd --gid "$AGENTRUN_ARCHIL_GID" agentrun-tool; \
    useradd --uid 2510 --gid "$AGENTRUN_ARCHIL_GID" --no-create-home --home-dir /tmp --shell /bin/sh agentrun-tool; \
    useradd --create-home --shell /bin/bash daytona; \
    install -d -o daytona -g daytona -m 0755 /workspace

COPY agentrun-archil /usr/local/sbin/agentrun-archil
COPY sudoers /etc/sudoers.d/agentrun-archil

# What the helper runs, where it runs it from: a box that lacks one fails here, not at a run's first mount.
RUN set -eu; \
    chown root:root /usr/local/sbin/agentrun-archil /etc/sudoers.d/agentrun-archil; \
    chmod 0755 /usr/local/sbin/agentrun-archil; \
    chmod 0440 /etc/sudoers.d/agentrun-archil; \
    visudo -c -q -f /etc/sudoers.d/agentrun-archil; \
    for x in /usr/bin/archil /usr/sbin/iptables /usr/sbin/ip6tables /usr/bin/getent /usr/bin/sudo /usr/bin/awk \
      /usr/bin/realpath /usr/bin/mount; do \
      [ -x "$x" ] || { echo "the image has no $x" >&2; exit 1; }; \
    done; \
    ids="$(id -u agentrun-tool):$(id -g agentrun-tool)"; \
    [ "$ids" = "2510:$AGENTRUN_ARCHIL_GID" ] || { echo "agentrun-tool is $ids" >&2; exit 1; }; \
    archil --version | head -1

USER daytona
# A box's first process is its provider's own (Daytona's runs this when a snapshot names no entrypoint; the Modal
# sandbox's is its own sleep): never the base image's python.
CMD ["sleep", "infinity"]
