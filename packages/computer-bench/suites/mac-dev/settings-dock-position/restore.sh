# Put back the value setup kept (no key at all when the Mac had none), and drop the copy.
o="/tmp/computer-bench-{{nonce}}"
v=$(cat "$o/orientation.orig" 2>/dev/null || echo absent)
case "$v" in
	left|right|bottom) defaults write com.apple.dock orientation -string "$v" ;;
	*) defaults delete com.apple.dock orientation 2>/dev/null || true ;;
esac
killall Dock
rm -rf "$o"
