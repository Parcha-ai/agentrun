#!/usr/bin/env bash
# Notarizes a Developer ID build of Computerd.app (bundle.sh with a "Developer ID Application:" COMPUTERD_SIGN_IDENTITY)
# and staples the ticket to it, so Gatekeeper opens it on any Mac without asking Apple first.
#
#   scripts/notarize.sh PATH/TO/Computerd.app     writes PATH/TO/Computerd.zip, the stapled app, and prints its sha256
#
# COMPUTERD_NOTARY_PROFILE names the notarytool keychain profile that holds the App Store Connect API key
# (`xcrun notarytool store-credentials <profile> --key <.p8> --key-id <id> --issuer <issuer>`), so no key reaches this
# script. COMPUTERD_NOTARY_KEYCHAIN, when set, is the keychain that holds the profile, in place of the search list.
set -euo pipefail

app="${1:?usage: notarize.sh PATH/TO/Computerd.app}"
[[ -d "$app" ]] || { echo "notarize: $app is not an app bundle" >&2; exit 1; }
app="$(cd "$app" && pwd)"
profile="${COMPUTERD_NOTARY_PROFILE:?COMPUTERD_NOTARY_PROFILE names the notarytool keychain profile}"
keychain=()
if [[ -n "${COMPUTERD_NOTARY_KEYCHAIN:-}" ]]; then
	keychain=(--keychain "$COMPUTERD_NOTARY_KEYCHAIN")
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Apple takes a zip of the app; the ticket is stapled to the app itself, so the zip people download is made after.
ditto -c -k --keepParent "$app" "$work/submit.zip"
# notarytool's own exit doesn't say whether Apple accepted the build: the status in its answer does.
rc=0
xcrun notarytool submit "$work/submit.zip" --keychain-profile "$profile" ${keychain[@]+"${keychain[@]}"} \
	--wait --timeout 1h --output-format json >"$work/submit.json" || rc=$?
answer="$(cat "$work/submit.json")"
id="$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' <<<"$answer")"
status="$(sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' <<<"$answer")"
if [[ "$status" != Accepted ]]; then
	echo "notarize: Apple did not accept $app (status \"${status:-none}\", notarytool exit $rc): $answer" >&2
	if [[ -n "$id" ]]; then
		echo "notarize: the notary log of submission $id:" >&2
		xcrun notarytool log "$id" --keychain-profile "$profile" ${keychain[@]+"${keychain[@]}"} >&2 ||
			echo "notarize: notarytool could not fetch the log" >&2
	fi
	exit 1
fi
echo "notarize: Apple accepted submission $id"

xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl -a -t exec -vv "$app"

zip="${app%.app}.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
shasum -a 256 "$zip"
