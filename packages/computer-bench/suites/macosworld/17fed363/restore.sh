# Quit System Settings, put back the value setup kept (no key at all when the Mac had none), and drop the copy.
o="/tmp/computer-bench-{{nonce}}"
osascript -e 'if application id "com.apple.systempreferences" is running then tell application id "com.apple.systempreferences" to quit'
v=$(cat "$o/visibility.orig" 2> /dev/null || echo absent)
case "$v" in
	'' | *[!0-9]*) defaults delete com.apple.ncprefs content_visibility 2> /dev/null ;;
	*) defaults write com.apple.ncprefs content_visibility -int "$v" ;;
esac
rm -rf "$o"
true
