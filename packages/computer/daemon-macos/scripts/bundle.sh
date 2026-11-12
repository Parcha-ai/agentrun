#!/usr/bin/env bash
# Builds Computerd.app from this package and signs it.
#
#   scripts/bundle.sh [OUT_DIR]          writes OUT_DIR/Computerd.app (default: ./build)
#
# COMPUTERD_SIGN_IDENTITY is the one signing setting. "-" (the default) signs ad hoc, as CI does: macOS then pins each
# grant to this exact build, so a new build is granted again. A "Developer ID Application: <name> (<team>)" identity
# from the keychain signs for distribution, with the hardened runtime and a timestamp, and grants survive updates.
#
# The bundle:
#   Contents/MacOS/Computerd                        the app (ComputerdApp)
#   Contents/Helpers/computerd                      the command that relays to the app's socket
#   Contents/Library/LaunchAgents/ai.parcha.computerd.plist
#   Contents/Info.plist
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
identity="${COMPUTERD_SIGN_IDENTITY:--}"
config="${COMPUTERD_CONFIG:-release}"
out="${1:-$here/build}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

cd "$here"
swift build -c "$config" --product ComputerdApp
swift build -c "$config" --product computerd
bin="$(swift build -c "$config" --show-bin-path)"

app="$out/Computerd.app"
rm -rf "${out:?}/Computerd.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Helpers" "$app/Contents/Library/LaunchAgents"
cp "$bin/ComputerdApp" "$app/Contents/MacOS/Computerd"
cp "$bin/computerd" "$app/Contents/Helpers/computerd"
cp App/Info.plist "$app/Contents/Info.plist"
cp App/ai.parcha.computerd.plist "$app/Contents/Library/LaunchAgents/ai.parcha.computerd.plist"

options=()
if [[ "$identity" != "-" ]]; then
	options=(--options runtime --timestamp)
fi
# The helper first, then the app, which seals what it holds.
# (bash 3.2, macOS's own, calls an empty array unbound under set -u: hence the ${...+...}.)
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} --identifier ai.parcha.computerd.cli "$app/Contents/Helpers/computerd"
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} --entitlements App/Computerd.entitlements "$app"
codesign --verify --strict --deep "$app"
codesign --display --requirements - "$app" 2>&1 | sed -n 's/^designated => /designated requirement: /p'
echo "$app"
