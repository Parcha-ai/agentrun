# Keep the Mac's own appearance once (a second setup keeps the first copy), turn Auto off, then start from the opposite
# of the asked appearance.
set -e
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o"
if [ ! -f "$o/dark.orig" ]; then
	v=$(osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode')
	echo "$v" > "$o/dark.orig"
fi
if [ ! -f "$o/auto.orig" ]; then
	defaults read -g AppleInterfaceStyleSwitchesAutomatically > "$o/auto.orig" 2>/dev/null || echo absent > "$o/auto.orig"
fi
defaults delete -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null || true
osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to {{mode.start}}'
