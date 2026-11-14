# Keep the Mac's own value once (a second setup keeps the first copy), then start from the opposite of the asked state.
set -e
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o"
if [ ! -f "$o/autohide.orig" ]; then
	defaults read com.apple.dock autohide > "$o/autohide.orig" 2>/dev/null || echo absent > "$o/autohide.orig"
fi
defaults write com.apple.dock autohide -bool {{mode.start}}
killall Dock
