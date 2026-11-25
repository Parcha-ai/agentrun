#!/bin/sh
# The box image's build, as POSIX shell: every step of it, run as root on the base the Dockerfile starts from
# (python:3.12-slim, Debian). The Dockerfile copies this file and agentrun-archil into one folder and runs it, and that is
# all it does. A vendor that builds images in its own account (a snapshot, a blueprint, a template) does the same: it
# boots that base, puts both files in one folder there, runs `sh install.sh` as root, and snapshots the machine under a
# name that carries the recipe's hash (recipe.mjs). The Dockerfile's comment says what each part of the image is for.
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
# The entrypoint of a machine that dials the server (dial below).
DIAL=/usr/local/bin/agentrun-dial

here=$(dirname "$0")

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

# agentrun-dial, the image's entrypoint when the provider's create set AGENTRUN_ATTACH_URL (the Dockerfile's CMD): for a
# vendor that boots the image with env but has no exec stream into it, so the machine dials the server
# (spec/computer/attach.md). The provider's exec path never runs it.
dial() {
	cat >"$DIAL" <<'EOF'
#!/bin/sh
# agentrun-dial (written by the box image's install.sh): a machine that dials the server. From the env the provider's
# create gave it, it fetches the server's computerd with the machine's token, checks its sha256, installs it root's alone
# where the provider's exec install puts it, starts `computerd init` as that start does, in a clean environment without
# the token (with DISPLAY, for a desktop), and becomes `computerd attach` with the attach URL and the token alone in its environment. Before init, it
# gives /workspace to init's user (its --user), 0700, where a synced folder's runner pushes the run's folder. A daemon
# whose sha256 is not AGENTRUN_DAEMON_SHA256 is removed, and nothing runs. With AGENTRUN_ATTACH_EGRESS, the operator's
# relay (<IPv4>:<port>), the fetch and attach's dial both connect to the relay and speak TLS and HTTP to the URL's host
# through it, and attach is given it too. The fetch is tried again, after 1, 2, 4 then 8 s, on a connection that failed
# (refused, reset, dropped in TLS, timed out) or an HTTP 5xx, within FETCH_S seconds in all (each try's transfer is
# held to the seconds left, so a stalled or trickling one ends there too), one line on stderr per retry;
# an HTTP 4xx is the server's refusal and is never tried again. Exits 2 for env missing or a malformed relay, 3 when the
# fetch failed, 4 for a sha256 mismatch, 5 when init never listened (init is ended first, so agentrun-dial may be
# started again), 6 when /workspace was not made init's user's, 7 when the server refused the fetch; else it is
# `computerd attach` and exits as it does.
set -euf
DAEMON=/opt/agentrun/computerd
HOME_DIR=/work
SOCKET_DIR=/run/agentrun
INIT_LOG=/run/agentrun-init.log
WORKSPACE=/workspace
OWNER=0:0
FETCH_S=45
INIT_WAIT_TENTHS=300
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for v in AGENTRUN_ATTACH_URL AGENTRUN_ATTACH_TOKEN AGENTRUN_DAEMON_URL AGENTRUN_DAEMON_SHA256 AGENTRUN_INIT_ARGS; do
	eval "[ -n \"\${$v-}\" ]" || { echo "agentrun-dial: $v is not set; the provider's create sets it" >&2; exit 2; }
done
# The operator's relay, where the machine reaches the server only through it (a provider's attach egress): curl connects
# there and speaks TLS and HTTP to the URL's host as it would directly (--connect-to keeps the SNI, the certificate check
# and the Host header the URL's). Digits, dots and colons alone, so it splits into exactly curl's two words; attach
# checks its shape whole.
relay=
case "${AGENTRUN_ATTACH_EGRESS-}" in
"") ;;
*[!0-9.:]*) echo "agentrun-dial: AGENTRUN_ATTACH_EGRESS is the relay's <IPv4>:<port>; the provider's create sets it" >&2; exit 2 ;;
*) relay="--connect-to ::$AGENTRUN_ATTACH_EGRESS" ;;
esac
# init's user, uid:gid, from its --user: /workspace is that user's alone, never a link.
user=
set -- $AGENTRUN_INIT_ARGS
while [ $# -gt 1 ]; do
	[ "$1" != --user ] || user=$2
	shift
done
[ -n "$user" ] || { echo "agentrun-dial: AGENTRUN_INIT_ARGS names no --user; the provider's create sets it" >&2; exit 2; }
{ [ ! -L "$WORKSPACE" ] && mkdir -p "$WORKSPACE" && chown "$user" "$WORKSPACE" && chmod 0700 "$WORKSPACE"; } ||
	{ echo "agentrun-dial: $WORKSPACE was not made $user's" >&2; exit 6; }
mkdir -p "${DAEMON%/*}" "$HOME_DIR" "$SOCKET_DIR"
chown "$OWNER" "${DAEMON%/*}" "$SOCKET_DIR"
chmod 0755 "${DAEMON%/*}"
# init's socket is root's alone: whoever can connect to it drives the machine.
chmod 0700 "$SOCKET_DIR"
rm -f "$DAEMON.part"
# One try of the fetch, in at most $1 seconds: the HTTP status on stdout, 000 when no answer came. The token goes to curl
# on its stdin, never on a command line, which every user may read in /proc.
fetch() {
	printf 'Authorization: Bearer %s\n' "$AGENTRUN_ATTACH_TOKEN" |
		curl -sS --connect-timeout 10 --max-time "$1" --speed-limit 1024 --speed-time 30 $relay -H @- -o "$DAEMON.part" -w '%{http_code}' "$AGENTRUN_DAEMON_URL"
}
unfetched() {
	echo "agentrun-dial: fetching the daemon from $AGENTRUN_DAEMON_URL${relay:+ through $AGENTRUN_ATTACH_EGRESS} failed: $1" >&2
	rm -f "$DAEMON.part"
	exit "$2"
}
tries() { if [ "$1" = 1 ]; then echo "1 try"; else echo "$1 tries"; fi; }
began=$(date +%s)
try=1
pause=1
why="no time was left"
while :; do
	left=$((FETCH_S - ($(date +%s) - began)))
	[ "$left" -ge 1 ] || unfetched "$why, after $(tries $((try - 1)))" 3
	code=0
	answer=$(fetch "$left") || code=$?
	case "$code:$answer" in
	0:2??) break ;;
	0:4??) unfetched "the server answered HTTP $answer" 7 ;;
	0:5??) why="the server answered HTTP $answer" ;;
	0:*) unfetched "the server answered HTTP $answer" 3 ;;
	5:* | 6:* | 7:* | 28:* | 35:* | 52:* | 55:* | 56:*) why="curl exit $code" ;;
	*) unfetched "curl exit $code" 3 ;;
	esac
	[ $(($(date +%s) - began + pause)) -lt "$FETCH_S" ] || unfetched "$why, after $(tries "$try")" 3
	echo "agentrun-dial: the daemon fetch's try $try failed ($why); trying again in $pause s" >&2
	sleep "$pause"
	try=$((try + 1))
	[ "$pause" -ge 8 ] || pause=$((pause * 2))
done
sum=$(sha256sum "$DAEMON.part" | cut -c1-64)
if [ "$sum" != "$AGENTRUN_DAEMON_SHA256" ]; then
	rm -f "$DAEMON.part"
	echo "agentrun-dial: the daemon from $AGENTRUN_DAEMON_URL reads sha256 $sum, not $AGENTRUN_DAEMON_SHA256, so nothing runs" >&2
	exit 4
fi
chown "$OWNER" "$DAEMON.part"
chmod 0755 "$DAEMON.part"
mv -f "$DAEMON.part" "$DAEMON"
# init's arguments are words with no space and no pattern (set -f): split, never globbed. A desktop's create sets
# DISPLAY, the display init's screen and input methods drive, as the provider's exec start gives it.
env -i PATH="$PATH" HOME="$HOME_DIR" AGENTRUN_COMPUTERD_SOCKET="$SOCKET_DIR/computerd.sock" ${DISPLAY:+DISPLAY="$DISPLAY"} \
	setsid sh -c 'cd "$HOME" && exec "$@"' sh "$DAEMON" init $AGENTRUN_INIT_ARGS >"$INIT_LOG" 2>&1 </dev/null &
# setsid in a background job, never its process group's leader, makes init's own session in place: $! leads it.
init=$!
i=0
until [ -S "$SOCKET_DIR/computerd.sock" ]; do
	i=$((i + 1))
	if [ "$i" -gt "$INIT_WAIT_TENTHS" ]; then
		echo "agentrun-dial: init did not listen at $SOCKET_DIR/computerd.sock within $((INIT_WAIT_TENTHS / 10)).$((INIT_WAIT_TENTHS % 10)) s; its log:" >&2
		cat "$INIT_LOG" >&2
		# init's group exists once setsid has run; until then $! is the start itself, ended by its pid alone.
		kill -s TERM -- "-$init" 2>/dev/null || :
		kill -s TERM "$init" 2>/dev/null || :
		exit 5
	fi
	sleep 0.1
done
# attach's environment: the URL and token alone, and the relay when given (it dials init at its default socket,
# SOCKET_DIR's).
for v in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
	case "$v" in AGENTRUN_ATTACH_URL | AGENTRUN_ATTACH_TOKEN | AGENTRUN_ATTACH_EGRESS | DAEMON) ;; *) unset "$v" 2>/dev/null || : ;; esac
done
exec "$DAEMON" attach
EOF
}

# What the helper and agentrun-dial run, where they run it from: an image that lacks one fails here, not at a run's
# first mount. And no way to root for the tool user: no sudo, no sudoers. A provider's builder may add sudo to the base
# before these steps (E2B's does): it is taken away first, the package where it is installed and every sudoers file,
# then checked gone.
checked() {
	if dpkg -s sudo >/dev/null 2>&1; then SUDO_FORCE_REMOVE=yes DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq sudo >/dev/null; fi
	rm -rf /etc/sudoers /etc/sudoers.d
	chown root:root "$HELPER" "$DIAL"
	chmod 0755 "$HELPER" "$DIAL"
	for x in /usr/bin/archil /usr/bin/awk /usr/bin/realpath /usr/bin/mount /usr/bin/chown /usr/bin/find /usr/bin/id /usr/bin/ls /usr/bin/curl /usr/bin/setsid /usr/bin/sha256sum /usr/bin/date; do
		[ -x "$x" ] || { echo "the image has no $x" >&2; exit 1; }
	done
	! command -v sudo >/dev/null 2>&1 || { echo "the image has sudo" >&2; exit 1; }
	[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo "the image has a sudoers file" >&2; exit 1; }
	ids="$(id -u agentrun-tool):$(id -g agentrun-tool)"
	[ "$ids" = "2510:2510" ] || { echo "agentrun-tool is $ids" >&2; exit 1; }
	archil --version | head -1
}

case "$*" in
"") packages; desktop; helper; dial; checked ;;
checked) checked ;;
*) echo "usage: sh install.sh [checked]" >&2; exit 2 ;;
esac
