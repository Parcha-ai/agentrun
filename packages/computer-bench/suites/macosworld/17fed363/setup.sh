# Keep the Mac's own notification-preview setting once (a retried setup keeps the first copy), quit System Settings, and
# start from "When Unlocked" (2), so the agent has to change it.
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o" || exit 1
osascript -e 'if application id "com.apple.systempreferences" is running then tell application id "com.apple.systempreferences" to quit'
if [ ! -f "$o/visibility.orig" ]; then
	defaults read com.apple.ncprefs content_visibility > "$o/visibility.orig" 2> /dev/null || echo absent > "$o/visibility.orig"
fi
defaults write com.apple.ncprefs content_visibility -int 2
