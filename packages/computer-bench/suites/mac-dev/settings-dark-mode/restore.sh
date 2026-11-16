# Put back the appearance and the Auto setting setup kept, and drop the copies. Each is put back only when setup kept
# it: a setup that stopped before it changed nothing of it.
o="/tmp/computer-bench-{{nonce}}"
if [ -f "$o/dark.orig" ]; then
	d=$(cat "$o/dark.orig")
	case "$d" in true|false) osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $d" ;; esac
fi
if [ -f "$o/auto.orig" ]; then
	case "$(cat "$o/auto.orig")" in
		1) defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool true ;;
		0) defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool false ;;
		*) defaults delete -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null || true ;;
	esac
fi
rm -rf "$o"
