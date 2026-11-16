#!/usr/bin/env bash
# CI only, on a throwaway runner: grants Computerd.app Accessibility, Screen Recording, Post Event, calendar data, and
# Automation of the demos' five apps by writing rows to the TCC databases, and marks the screen capture alert as
# answered. Writing the system database works only where SIP is off, as on GitHub's macOS runners; on a person's Mac
# the grants are theirs to give, in System Settings.
#
#   scripts/seed-tcc.sh PATH/TO/Computerd.app
#
# Each write is reported, and a refusal is not fatal: the smoke test then checks that hello says why a feature is off.
# tccd holds the user database at times ("database is locked"), so each write waits up to 10 s for it.
# Never run this on a person's Mac.
set -uo pipefail

app="${1:?usage: seed-tcc.sh PATH/TO/Computerd.app}"
id=ai.parcha.computerd
[[ "${CI:-}" == "true" ]] || { echo "seed-tcc.sh runs on CI runners only" >&2; exit 2; }

echo "SIP: $(csrutil status 2>&1)"
# An ad-hoc signature's requirement is implicit, so codesign prints it as a comment: "# designated => cdhash H"…"".
requirement="$(codesign --display --requirements - "$app" 2>&1 | sed -n 's/^#* *designated => //p')"
echo "designated requirement: $requirement"
blob="$(mktemp)"
printf '%s' "$requirement" | csreq -r- -b "$blob" || { echo "csreq could not compile the requirement"; exit 0; }
hex="$(xxd -p "$blob" | tr -d '\n')"
now="$(date +%s)"

seed() {
	local db="$1" service="$2" sudo="$3"
	local sql="INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, indirect_object_identifier, flags, last_modified) VALUES ('$service', '$id', 0, 2, 4, 1, X'$hex', 'UNUSED', 0, $now);"
	if $sudo sqlite3 -cmd ".timeout 10000" "$db" "$sql" 2>&1; then
		echo "seeded $service in $db"
	else
		echo "could not seed $service in $db"
	fi
}

system_db="/Library/Application Support/com.apple.TCC/TCC.db"
user_db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
for service in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent; do
	seed "$system_db" "$service" sudo
	seed "$user_db" "$service" ""
done
# Calendar data: without it the demos' first AppleScript to Calendar got no answer in 60 s on the runner, twice; with
# it, it answered (mini-demos.py's can-automate.swift checks it as "calendars").
seed "$user_db" kTCCServiceCalendar ""

# Automation (Apple events) from Computerd to the demos' five apps: mini-demos.py makes and removes each task's sandbox
# by AppleScript through Computerd's exec.run. A row names the target too, by bundle id and its code requirement.
for target in /System/Applications/Calendar.app /System/Applications/Notes.app /System/Applications/TextEdit.app \
	/System/Library/CoreServices/Finder.app /Applications/Safari.app; do
	target_id="$(defaults read "$target/Contents/Info" CFBundleIdentifier 2>/dev/null)" || { echo "no $target"; continue; }
	target_blob="$(mktemp)"
	codesign --display --requirements - "$target" 2>&1 | sed -n 's/^#* *designated => //p' | csreq -r- -b "$target_blob" \
		|| { echo "csreq could not compile $target_id's requirement"; continue; }
	target_hex="$(xxd -p "$target_blob" | tr -d '\n')"
	sql="INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified) VALUES ('kTCCServiceAppleEvents', '$id', 0, 2, 4, 1, X'$hex', 0, '$target_id', X'$target_hex', 0, $now);"
	if sqlite3 -cmd ".timeout 10000" "$user_db" "$sql" 2>&1; then
		echo "seeded kTCCServiceAppleEvents for $target_id in $user_db"
	else
		echo "could not seed kTCCServiceAppleEvents for $target_id in $user_db"
	fi
done

# The capture alert (macOS 15 and later) keeps its schedule in replayd's approvals: a next-alert date far ahead means
# it never shows. (Learned from Cua Driver's test runners; see NOTICE.) On macOS 26 an ad hoc signed app's entry is
# keyed by its bundle's file URL ("file:///…/Computerd.app/"), not its bundle id: an entry by bundle id left the alert
# up on CI (it read the URL's entry, which replayd made when it first alerted).
approvals="$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
mkdir -p "$(dirname "$approvals")"
python3 -I - "$approvals" "$app" <<'PY' && echo "marked the capture alert answered" || echo "could not mark the capture alert"
import datetime, os, pathlib, plistlib, sys
path, app = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    with open(path, "rb") as f:
        data = plistlib.load(f)
far = datetime.datetime(3024, 1, 1)
data[pathlib.Path(app).resolve().as_uri() + "/"] = {
    "kScreenCaptureAlertableUsageCount": 0,
    "kScreenCaptureApprovalLastAlerted": far,
    "kScreenCaptureApprovalLastUsed": far,
    "kScreenCapturePrivacyHintDate": far,
    "kScreenCapturePrivacyHintPolicy": 2592000,
}
with open(path, "wb") as f:
    plistlib.dump(data, f, fmt=plistlib.FMT_BINARY)
PY
killall replayd 2>/dev/null || true
exit 0
