# Put back the value setup kept (no key at all when the Mac had none), and drop the copy. A setup that kept nothing
# changed nothing, so nothing is put back.
o="/tmp/computer-bench-{{nonce}}"
[ -f "$o/orientation.orig" ] || exit 0
v=$(cat "$o/orientation.orig")
case "$v" in
	left|right|bottom) defaults write com.apple.dock orientation -string "$v" ;;
	*) defaults delete com.apple.dock orientation 2>/dev/null || true ;;
esac
killall Dock
rm -rf "$o"
