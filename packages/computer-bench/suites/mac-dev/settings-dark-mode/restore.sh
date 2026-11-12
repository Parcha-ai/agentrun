# Put back the appearance and the Auto setting setup kept, and drop the copies.
o="/tmp/computer-bench-{{nonce}}"
d=$(cat "$o/dark.orig" 2>/dev/null || echo false)
case "$d" in true|false) ;; *) d=false ;; esac
osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $d"
a=$(cat "$o/auto.orig" 2>/dev/null || echo absent)
case "$a" in
	1) defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool true ;;
	0) defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool false ;;
	*) defaults delete -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null || true ;;
esac
rm -rf "$o"
