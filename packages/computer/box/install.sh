#!/bin/sh
# The box image's build, as POSIX shell: every step of it, run as root on the base the Dockerfile starts from
# (python:3.12-slim, Debian). The Dockerfile copies this file and agentrun-archil into one folder and runs it, and that is
# all it does. A vendor that builds images in its own account (a snapshot, a blueprint, a template) does the same: it
# boots that base, puts both files in one folder there, runs `sh install.sh` as root, and snapshots the machine under a
# name that carries the recipe's hash (recipe.mjs). A vendor that builds from a Dockerfile builds that one; one that
# needs its own base or agent in the image builds recipe.mjs's vendorDockerfile, which runs this. Any base must be
# Debian: the packages are Debian's, through apt, so the first step refuses another in words. The Dockerfile's comment
# says what each part of the image is for.
#
#   sh install.sh            the whole build
#   sh install.sh checked    the last step alone: any sudo taken away, then every check. recipe.mjs's onImage runs it on
#                            the published image, after E2B's template builder has added sudo there.
#
# It reads the network only through apt (Debian's mirrors) and for Archil's package. Run twice on one machine it ends the
# same, for a vendor's snapshot flow may retry it: each step that makes something looks for it first.
set -eu

# The archil client the live checks ran. A sum that reads `unpinned` stops the build, saying so: pin both before any build.
ARCHIL_VERSION=0.10.1-1793222256
ARCHIL_SHA256_AMD64=f219e70287e8152f3f0c7222e1c3319f4665897235af7c33a8846e56a5a5786a
ARCHIL_SHA256_ARM64=10ed430e51c268af095dd9e6c7aa6cdbb951d2430d62a76458719db168f40c0e
# Where the provider runs the root helper from.
HELPER=/usr/local/sbin/agentrun-archil

here=$(dirname "$0")

# The base is Debian, read from its os-release file: apt is how every package comes in, and Debian's names them (Ubuntu
# has apt, but no firefox-esr). Another base is refused here, before anything is installed.
debian() {
	grep -Eqs "^ID=[\"']?debian[\"']?\$" "$1" && return 0
	name="$(sed -n "s/^PRETTY_NAME=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}\$/\1/p" "$1" 2>/dev/null || :)"
	echo "install.sh builds on Debian (its packages are Debian's, through apt), and this base is ${name:-unnamed} by $1: start FROM python:3.12-slim, debian:bookworm-slim or a vendor's base built on Debian" >&2
	exit 1
}

# A coding agent's tools, FUSE, nftables and the archil client (checked by sha256), the tool user, and /workspace.
packages() {
	arch="$(dpkg --print-architecture)"
	case "$arch" in
	amd64) sum="$ARCHIL_SHA256_AMD64" ;;
	arm64) sum="$ARCHIL_SHA256_ARM64" ;;
	*) echo "no archil client for $arch" >&2; exit 1 ;;
	esac
	case "$sum" in unpinned) echo "archil ${ARCHIL_VERSION} for $arch has no pinned sha256 yet: set ARCHIL_SHA256_$(echo "$arch" | tr a-z A-Z) to the package's sum" >&2; exit 1 ;; esac
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
		git curl ca-certificates nodejs npm ripgrep fuse3 nftables >/dev/null
	if [ "$(dpkg-query -W -f '${Version}' archil 2>/dev/null)" != "$ARCHIL_VERSION" ]; then
		curl -fsSL -o /tmp/archil.deb "https://s3.amazonaws.com/archil-client/pkg/archil_${ARCHIL_VERSION}_${arch}.deb"
		echo "$sum  /tmp/archil.deb" | sha256sum -c -
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends /tmp/archil.deb >/dev/null
	fi
	rm -rf /var/lib/apt/lists/* /tmp/archil.deb
	getent group agentrun-tool >/dev/null || groupadd --gid 2510 agentrun-tool
	id -u agentrun-tool >/dev/null 2>&1 || useradd --uid 2510 --gid 2510 --no-create-home --home-dir /tmp --shell /bin/sh agentrun-tool
	install -d -o root -g root -m 0755 /workspace
}

# The desktop: Xvfb and xfwm4, which the provider starts through computerd as the tool user on :0, and the apps an agent
# opens. Each program and each app's desktop file is checked here. It comes before the last step, so a package that
# brought sudo is taken away and checked gone there (a check here would refuse E2B's build, whose builder adds sudo first).
desktop() {
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
		xvfb xfwm4 x11-xserver-utils xfce4-terminal mousepad firefox-esr xdotool fonts-dejavu-core adwaita-icon-theme >/dev/null
	rm -rf /var/lib/apt/lists/*
	for x in Xvfb xfwm4 dbus-run-session xsetroot xfce4-terminal mousepad firefox-esr xdotool; do command -v "$x" >/dev/null || { echo "the image has no $x" >&2; exit 1; }; done
	for app in org.xfce.mousepad xfce4-terminal firefox-esr; do [ -f "/usr/share/applications/$app.desktop" ] || { echo "the image has no desktop file $app.desktop" >&2; exit 1; }; done
}

# The root helper, from beside this file.
helper() {
	cp "$here/agentrun-archil" "$HELPER"
}

# What the helper runs, where it runs it from: an image that lacks one fails here, not at a run's first mount. And no way
# to root for the tool user: no sudo, no sudoers. A provider's builder may add sudo to the base before these steps
# (E2B's does): it is taken away first, the package where it is installed and every sudoers file, then checked gone.
checked() {
	if dpkg -s sudo >/dev/null 2>&1; then SUDO_FORCE_REMOVE=yes DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq sudo >/dev/null; fi
	rm -rf /etc/sudoers /etc/sudoers.d
	chown root:root "$HELPER"
	chmod 0755 "$HELPER"
	for x in /usr/bin/archil /usr/bin/awk /usr/bin/realpath /usr/bin/mount /usr/bin/chown /usr/bin/find /usr/bin/id /usr/bin/ls; do
		[ -x "$x" ] || { echo "the image has no $x" >&2; exit 1; }
	done
	! command -v sudo >/dev/null 2>&1 || { echo "the image has sudo" >&2; exit 1; }
	[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo "the image has a sudoers file" >&2; exit 1; }
	ids="$(id -u agentrun-tool):$(id -g agentrun-tool)"
	[ "$ids" = "2510:2510" ] || { echo "agentrun-tool is $ids" >&2; exit 1; }
	archil --version | head -1
}

case "$*" in
"") debian /etc/os-release; packages; desktop; helper; checked ;;
checked) checked ;;
*) echo "usage: sh install.sh [checked]" >&2; exit 2 ;;
esac
