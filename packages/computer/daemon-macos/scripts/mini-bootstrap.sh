#!/usr/bin/env bash
# The Mac mini's bootstrap (MINI.md): builds Computerd.app and the ui fixture, signs both with this Mac's own stable
# identity, installs them in /Applications, opens the two System Settings panes a person must switch on, and runs the
# smoke check against the installed app. Run it again after every pull: the grants survive, since they are tied to
# the identity and not to the build.
#
#   scripts/mini-bootstrap.sh [--conformance]
#
#   --conformance  then also runs the protocol's ui conformance cases (needs Node 24 and the repo's npm ci)
#
# Runs as the Mac's auto-login user, over SSH or in Terminal; never with sudo. The last line is PASS or FAIL.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
conformance=0
for arg in "$@"; do
	case "$arg" in
	--conformance) conformance=1 ;;
	*) echo "usage: mini-bootstrap.sh [--conformance]" >&2; exit 2 ;;
	esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAIL: %s\n' "$*"; exit 1; }

label=ai.parcha.computerd
domain="gui/$(id -u)"
app=/Applications/Computerd.app
fixture=/Applications/UIFixture.app
computerd="$app/Contents/Helpers/computerd"
home="$HOME/Library/Application Support/Computerd"

say "this Mac"
[[ "$(id -u)" != 0 ]] || die "run as the auto-login user, not root"
[[ "$(uname)" == Darwin ]] || die "this is not a Mac"
version="$(sw_vers -productVersion)"
echo "macOS $version ($(sw_vers -buildVersion)), $(uname -m), user $(id -un)"
[[ "${version%%.*}" -ge 26 ]] || die "macOS 26 or later is needed, this is $version"
developer="$(xcode-select -p 2>/dev/null || true)"
[[ "$developer" == *Xcode*.app/* ]] || die "xcode-select points at '$developer': install Xcode 26 or later and run: sudo xcode-select -s /Applications/Xcode.app"
# (sed -n 1p, never head: under pipefail, head closing the pipe early fails the script with the writer's SIGPIPE.)
xcodebuild -version | sed -n 1p
swift --version 2>&1 | sed -n 1p
console="$(stat -f %Su /dev/console)"
[[ "$console" == "$(id -un)" ]] || die "the logged-in desktop belongs to '$console': log in as $(id -un) (MINI.md: auto-login)"

say "the signing identity"
# Made the first time (scripts/local-identity.sh): the app's designated requirement then names this certificate, and
# macOS keeps the Accessibility and Screen Recording grants across rebuilds.
hash="$("$here/scripts/local-identity.sh")" || die "no signing identity (the lines above say why)"

say "building Computerd.app and the ui fixture"
build="$here/build"
COMPUTERD_SIGN_IDENTITY="$hash" COMPUTERD_UI_FIXTURE=1 "$here/scripts/bundle.sh" "$build"
codesign --display --requirements - "$build/Computerd.app" 2>&1 | grep -E 'certificate (leaf|root) = H"' >/dev/null \
	|| die "Computerd.app's designated requirement does not name the certificate, so a rebuild would lose the grants"

say "closing Computerd's window"
# A Computerd still running that is not the agent is an old build's grants window: it goes before the swap. The agent
# keeps running, and is restarted on the new build below.
agent_pid="$(launchctl print "$domain/$label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | sed -n 1p)"
for pid in $(pgrep -x -u "$(id -u)" Computerd || true); do
	[[ "$pid" == "$agent_pid" ]] && continue
	echo "ending Computerd's window, pid $pid"
	kill "$pid" 2>/dev/null || true
done

say "installing in /Applications"
# Each bundle is copied beside the old one, then swapped in.
install_app() {
	local from="$1" to="$2"
	rm -rf "${to:?}.new"
	ditto "$from" "$to.new"
	rm -rf "${to:?}"
	mv "$to.new" "$to"
	echo "installed $to"
}
install_app "$build/Computerd.app" "$app"
install_app "$build/UIFixture.app" "$fixture"
# Launch Services learns the new bundles now, so apps.list and apps.launch find them at once.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" "$fixture"

say "the LaunchAgent"
# A plain user LaunchAgent, with the keys the app writes when a person opens it (Agent.job in
# Sources/ComputerdApp/Agent.swift). It runs the app's executable by its path, so a rebuild at the same path is only a
# restart. Not SMAppService: its launch constraint pinned a self-signed agent to the build that registered it, and
# launchd killed every rebuild at spawn ("needs LWCR update").
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
exe="$app/Contents/MacOS/Computerd"
if [[ -f "$plist" && "$(plutil -extract ProgramArguments.0 raw "$plist" 2>/dev/null || true)" == "$exe" ]] \
	&& launchctl print "$domain/$label" >/dev/null 2>&1; then
	echo "loaded from $plist: restarting it on the new build"
	launchctl kickstart -k "$domain/$label"
else
	mkdir -p "$agents"
	cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$label</string>
	<key>ProgramArguments</key><array><string>$exe</string></array>
	<key>AssociatedBundleIdentifiers</key><array><string>$label</string></array>
	<key>EnvironmentVariables</key><dict><key>COMPUTERD_SERVE</key><string>1</string></dict>
	<key>LimitLoadToSessionType</key><string>Aqua</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
	plutil -lint "$plist" >/dev/null || die "$plist is not a valid plist"
	launchctl bootout "$domain/$label" 2>/dev/null && echo "booted out the old $label" || true
	loaded=0
	for _ in 1 2 3 4 5; do
		if launchctl bootstrap "$domain" "$plist" 2>/dev/null; then loaded=1; break; fi
		sleep 0.5
	done
	[[ "$loaded" == 1 ]] || { launchctl bootstrap "$domain" "$plist" || true; die "launchctl bootstrap $domain $plist failed (above)"; }
	echo "bootstrapped $plist"
fi
sleep 2
if ! launchctl print "$domain/$label" 2>&1 | grep -E '^[[:space:]]*state = running' >/dev/null; then
	launchctl print "$domain/$label" 2>&1 | grep -E 'state|last exit|spawn|LWCR' | sed 's/^/  /' || true
	die "launchd has the agent but it is not running (above)"
fi

# The grants window, opened as a person would: --until-granted closes it once every grant is on, so it never covers the
# windows the demos work in. (Opened by a person, the app writes the same plist; it finds it in place and leaves it.)
open -n "$app" --args --until-granted
for _ in $(seq 1 100); do
	[[ -S "$home/computerd.sock" ]] && "$computerd" hello >/dev/null 2>&1 && break
	sleep 0.1
done
"$computerd" hello >/dev/null || die "the agent serves no socket at $home/computerd.sock"
echo "the agent serves $home/computerd.sock"

# Prints the features that are still off, with why; empty when ui.tree, ui.image and ui.foreground are on.
features_off() {
	local reply
	reply="$("$computerd" hello 2>&1)" || { echo "  hello: $reply"; return; }
	printf '%s' "$reply" | python3 -I -c '
import json, sys
features = json.load(sys.stdin).get("result", {}).get("features", {})
for name in ("ui.tree", "ui.image", "ui.foreground", "ui.background"):
    feature = features.get(name)
    if feature is not True:
        print("  %s: %s" % (name, (feature or {}).get("off", "missing")))
'
}

say "the grants"
off="$(features_off)"
if [[ -n "$off" ]]; then
	echo "Off:"
	echo "$off"
	cat <<EOF

A person must switch these on, once (Screen Sharing over Tailscale works):
  1. In the Computerd window, click each "Allow…": it adds Computerd to the list and opens its pane.
  2. Privacy & Security > Accessibility: switch Computerd on (this also gives it Post Event).
  3. Privacy & Security > Screen & System Audio Recording: switch Computerd on.
  4. Back in the Computerd window, click "Raise it now" and answer Allow, so the capture alert never pops mid-task.
Both panes are open now. This waits up to 15 minutes, restarting the agent every 30 s so a new grant takes hold.
EOF
	open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
	open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
	waited=0
	while [[ -n "$off" && "$waited" -lt 900 ]]; do
		sleep 30
		waited=$((waited + 30))
		launchctl kickstart -k "$domain/$label"
		sleep 2
		off="$(features_off)"
	done
	[[ -z "$off" ]] || die "still off after 15 minutes:
$off"
fi
echo "ui.tree, ui.image, ui.foreground and ui.background are on"

say "smoke check"
status=0
SMOKE_STRICT_LIVE=1 python3 -I "$here/scripts/smoke.py" "$computerd" "$home" || status=$?

if [[ "$conformance" == 1 && "$status" == 0 ]]; then
	say "ui conformance"
	command -v node >/dev/null || die "--conformance needs Node 24 (MINI.md)"
	(cd "$repo" && npm ci --ignore-scripts && npm run build -w @parcha/agentrun-computer)
	"$here/scripts/ui-conformance.sh" "$computerd" "$home" || status=$?
fi

if [[ "$status" == 0 ]]; then
	printf '\nPASS: Computerd is installed, granted and answering on this Mac\n'
else
	printf '\nFAIL: the checks above that say FAIL\n'
	exit 1
fi
