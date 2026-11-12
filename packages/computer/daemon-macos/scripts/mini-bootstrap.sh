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
signing="$HOME/.computerd-signing"
keychain="$HOME/Library/Keychains/computerd-signing.keychain-db"
cn="Computerd Local Signing"

say "this Mac"
[[ "$(id -u)" != 0 ]] || die "run as the auto-login user, not root"
[[ "$(uname)" == Darwin ]] || die "this is not a Mac"
version="$(sw_vers -productVersion)"
echo "macOS $version ($(sw_vers -buildVersion)), $(uname -m), user $(id -un)"
[[ "${version%%.*}" -ge 26 ]] || die "macOS 26 or later is needed, this is $version"
developer="$(xcode-select -p 2>/dev/null || true)"
[[ "$developer" == *Xcode*.app/* ]] || die "xcode-select points at '$developer': install Xcode 26 and run: sudo xcode-select -s /Applications/Xcode.app"
xcodebuild -version | head -1
swift --version 2>&1 | head -1
console="$(stat -f %Su /dev/console)"
[[ "$console" == "$(id -un)" ]] || die "the logged-in desktop belongs to '$console': log in as $(id -un) (MINI.md: auto-login)"

say "the signing identity"
# Made once: a self-signed code signing certificate in a keychain of its own, whose password sits beside it, so
# signing works over SSH with no prompt. The app's designated requirement then names this certificate, and macOS keeps
# the Accessibility and Screen Recording grants across rebuilds.
mkdir -p "$signing"
chmod 700 "$signing"
if [[ ! -f "$signing/keychain-password" ]]; then
	(umask 077 && openssl rand -hex 24 >"$signing/keychain-password")
fi
password="$(cat "$signing/keychain-password")"
if [[ ! -f "$keychain" ]]; then
	security create-keychain -p "$password" "$keychain"
	echo "made $keychain"
fi
security unlock-keychain -p "$password" "$keychain"
security set-keychain-settings "$keychain" # no auto-lock: signing over SSH must not find it locked
if ! security find-certificate -c "$cn" "$keychain" >/dev/null 2>&1; then
	work="$(mktemp -d)"
	openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$cn" \
		-keyout "$work/key.pem" -out "$work/cert.pem" \
		-addext "basicConstraints=critical,CA:false" \
		-addext "keyUsage=critical,digitalSignature" \
		-addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
	# The legacy PKCS#12 ciphers: the only ones security import reads.
	openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$cn" -out "$work/identity.p12" \
		-passout "pass:$password" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
	security import "$work/identity.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign >/dev/null
	rm -rf "${work:?}"
	# Lets codesign use the key with no "allow" dialog, which SSH could not answer.
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
	echo "made the identity '$cn'"
fi
# codesign looks for identities in the user's keychain search list.
searched="$(security list-keychains -d user | tr -d '" ' | tr '\n' ' ')"
if [[ " $searched " != *" $keychain "* ]]; then
	# shellcheck disable=SC2086 # the list is paths without spaces, one word each
	security list-keychains -d user -s "$keychain" $searched
fi
hash="$(security find-certificate -c "$cn" -Z "$keychain" | awk '/SHA-1 hash:/ { print $NF; exit }')"
[[ -n "$hash" ]] || die "the identity '$cn' is not in $keychain"
echo "identity '$cn', SHA-1 $hash"

say "building Computerd.app and the ui fixture"
build="$here/build"
COMPUTERD_SIGN_IDENTITY="$hash" COMPUTERD_UI_FIXTURE=1 "$here/scripts/bundle.sh" "$build"
codesign --display --requirements - "$build/Computerd.app" 2>&1 | grep -Eq 'certificate (leaf|root) = H"' \
	|| die "Computerd.app's designated requirement does not name the certificate, so a rebuild would lose the grants"

say "installing in /Applications"
# Each bundle is copied beside the old one, then swapped in, so the running agent never sees half a bundle.
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
# Opened by a person (here, by open), the app registers its LaunchAgent and shows its grants window. The agent is the
# copy that serves the socket; it is restarted so it runs this build.
open "$app"
for _ in $(seq 1 30); do
	launchctl print "$domain/$label" >/dev/null 2>&1 && break
	sleep 1
done
launchctl print "$domain/$label" >/dev/null 2>&1 \
	|| die "the LaunchAgent is not loaded: in System Settings > General > Login Items & Extensions, allow Computerd"
launchctl kickstart -k "$domain/$label"
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
