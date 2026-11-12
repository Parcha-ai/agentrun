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

say "stopping the old agent"
# A self-signed build's LaunchAgent is pinned to the build that registered it: launchd kills any other build at spawn
# ("Launch Constraint Violation", exit 78 "needs LWCR update"). So the old agent stops before its bundle is swapped,
# and the new build registers again below. Any Computerd window still open is the old build: it goes too.
if launchctl bootout "$domain/$label" 2>/dev/null; then echo "booted out $label"; else echo "$label was not loaded"; fi
running="$(pgrep -x -u "$(id -u)" Computerd || true)"
if [[ -n "$running" ]]; then
	echo "ending Computerd: pid $(echo $running)"
	kill $running 2>/dev/null || true
	sleep 1
fi

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
# This build registers the agent again (unregister, awaited, then register), so launchd records this build's launch
# constraint. open starts it in the login session, where SMAppService works (-n: a new copy, so the argument is not
# lost on one already running); it writes the outcome to agent-status.txt and exits.
status_file="$home/agent-status.txt"
rm -f "$status_file"
# (open may complain that a copy which never shows a window did not check in: the status file decides.)
open -n "$app" --args --register-agent || echo "open exited $?: waiting for the status file anyway"
for _ in $(seq 1 60); do
	[[ -s "$status_file" ]] && break
	sleep 1
done
agent="$(cat "$status_file" 2>/dev/null || echo "unknown: Computerd --register-agent wrote nothing in 60 s")"
echo "SMAppService: the LaunchAgent is $agent"
echo "Computerd.log:"
{ sed -n '/LaunchAgent/p' "$HOME/Library/Logs/Computerd.log" 2>/dev/null || true; } | tail -n 4 | sed 's/^/  /'
case "$agent" in
enabled) ;;
requiresApproval) die "a person must switch Computerd on in System Settings > General > Login Items & Extensions (Screen Sharing works), then run this again" ;;
*) die "the LaunchAgent did not register: see Computerd.log above" ;;
esac

# The grants window, opened as a person would; --until-granted closes it once every grant is on, so it never covers the
# windows the demos work in.
open -n "$app" --args --until-granted
for _ in $(seq 1 30); do
	launchctl print "$domain/$label" >/dev/null 2>&1 && break
	sleep 1
done
if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
	cat "$status_file" 2>/dev/null | sed 's/^/SMAppService: /'
	die "the LaunchAgent is registered but launchd has not loaded it"
fi
# The agent is the copy that serves the socket; it is restarted so it runs this build.
launchctl kickstart -k "$domain/$label"
sleep 2
if launchctl print "$domain/$label" 2>&1 | grep -E 'needs LWCR update|last exit code = 78' >/dev/null; then
	launchctl print "$domain/$label" 2>&1 | grep -E 'state|last exit|LWCR|spawn' | sed 's/^/  /'
	die "launchd refuses this build of the agent (its launch constraint is for another build): run open -n $app --args --register-agent, then this again"
fi
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
