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
#   - nftables, for the helper's mount with an egress gateway alone: it redirects root's TCP to Archil's 8100 and 32050
#     to computerd's archil relay on the computer's loopback;
#   - /workspace, empty and root's, where the helper mounts the run's folder;
#   - a desktop, with nothing started: Xvfb and xfwm4 (with dbus-run-session, which xfconf's packages bring) and
#     xsetroot (x11-xserver-utils, the desktop's background), which the provider starts through computerd as the tool
#     user on :0 (src/desktop.ts), and the apps E2B Desktop has that are cheap to carry: Xfce's terminal and text editor,
#     Firefox ESR, and xdotool. computerd's apps group lists and opens them by their desktop files. No VNC server comes
#     with it. One image serves a sandbox and a desktop (an Agent37 desktop starts from it too).
#
# No sudo and no sudoers file: the image's user is root, so the provider's own exec (Daytona's toolbox, Modal's exec,
# E2B's commands as root) runs the helper as root, and the tool user has no way to root. The build fails if the base
# brings either. computerd is not part of the image: the provider uploads and installs it, root's alone, at create, and
# the helper's serve runs that one.
#
# /proc with hidepid=2 is not part of an image: the helper remounts /proc so before each mount, as root, and refuses the
# mount in a computer where that fails.
#
# Every step is install.sh's, so a vendor that builds images in its own account from a running machine runs the same
# build: this file only puts it and the helper in one folder, runs it as root, and removes the folder.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

COPY install.sh /tmp/agentrun-box/install.sh
COPY agentrun-archil /tmp/agentrun-box/agentrun-archil
RUN sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box

USER root
# A computer's first process is its provider's own (Daytona's runs this when a snapshot names no entrypoint; Modal's and
# E2B's are their own): never the base image's python.
CMD ["sleep", "infinity"]
