# Put back the value setup kept (no key at all when the Mac had none), and drop the copy. A setup that kept nothing
# changed nothing, so nothing is put back.
o="/tmp/computer-bench-{{nonce}}"
[ -f "$o/autohide.orig" ] || exit 0
v=$(cat "$o/autohide.orig")
case "$v" in
	1) defaults write com.apple.dock autohide -bool true ;;
	0) defaults write com.apple.dock autohide -bool false ;;
	*) defaults delete com.apple.dock autohide 2>/dev/null || true ;;
esac
killall Dock
rm -rf "$o"
