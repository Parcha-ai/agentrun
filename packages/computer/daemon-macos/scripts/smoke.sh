#!/usr/bin/env bash
# CI: starts Computerd.app the way its LaunchAgent does (launchd, in the runner's Aqua session), headless, and runs
# smoke.py against it through the app's own computerd command, then the protocol's ui conformance cases
# (ui-conformance.sh) when packages/computer is built.
#
#   scripts/smoke.sh PATH/TO/Computerd.app
set -euo pipefail

app="$(cd "$(dirname "${1:?usage: smoke.sh PATH/TO/Computerd.app}")" && pwd)/$(basename "$1")"
here="$(cd "$(dirname "$0")" && pwd)"
label=ai.parcha.computerd
domain="gui/$(id -u)"
home=/tmp/computerd-ci
mkdir -p "$home"
chmod 700 "$home"
export COMPUTERD_HOME="$home"

plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$(dirname "$plist")"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$label</string>
	<key>ProgramArguments</key><array><string>$app/Contents/MacOS/Computerd</string></array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>COMPUTERD_HOME</key><string>$home</string>
		<key>COMPUTERD_HEADLESS</key><string>1</string>
	</dict>
	<key>LimitLoadToSessionType</key><string>Aqua</string>
	<key>RunAtLoad</key><true/>
	<key>StandardErrorPath</key><string>$home/stderr.log</string>
</dict>
</plist>
EOF

direct=""
finish() {
	if [[ -n "$direct" ]]; then kill "$direct" 2>/dev/null || true; else launchctl bootout "$domain/$label" 2>/dev/null || true; fi
	echo "--- the app's log"
	cat "$home/stderr.log" 2>/dev/null || true
}
trap finish EXIT

launchctl bootout "$domain/$label" 2>/dev/null || true
if launchctl bootstrap "$domain" "$plist"; then
	echo "launchd started Computerd in $domain"
else
	echo "launchctl bootstrap $domain failed: starting Computerd directly (grants then follow the runner's process)"
	COMPUTERD_SERVE=1 COMPUTERD_HEADLESS=1 "$app/Contents/MacOS/Computerd" 2>"$home/stderr.log" &
	direct=$!
fi

smoke=0
python3 -I "$here/smoke.py" "$app/Contents/Helpers/computerd" "$home" || smoke=$?

# The protocol's ui conformance cases, on the same running app, when packages/computer is built.
conformance=0
if [[ -f "$here/../../dist/conformance/cli.js" ]]; then
	"$here/ui-conformance.sh" "$app/Contents/Helpers/computerd" "$home" || conformance=$?
else
	echo "packages/computer is not built (npm run build -w @parcha/agentrun-computer): the ui conformance cases do not run"
fi

# The Mac mini's demo tasks (mini-demos.py), recorded (each frame cut to the task's window): reported, and not yet a
# verdict here, since a runner's apps are fresh each time (first-run sheets, no account).
python3 -I "$here/mini-demos.py" "$app/Contents/Helpers/computerd" "$home" "$home/demos" --movie || echo "the demo tasks failed: see above"
# The grants asked of TCC while the tests and demos ran, counted by service: a grant the sandbox's AppleScript needs
# and seed-tcc.sh does not seed shows up here.
echo "TCC requests in the last 15 minutes, by service:"
log show --last 15m --style compact --predicate 'subsystem == "com.apple.TCC" AND eventMessage BEGINSWITH "AUTHREQ_CTX"' 2>&1 \
	| grep -oE 'service=kTCCService[A-Za-z]+' | sort | uniq -c || true
exit $((smoke || conformance))
