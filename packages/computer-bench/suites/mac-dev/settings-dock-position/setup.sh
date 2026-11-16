# Keep the Mac's own value once (a second setup keeps the first copy), then start from a position that is not the asked one.
set -e
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o"
if [ ! -f "$o/orientation.orig" ]; then
	defaults read com.apple.dock orientation > "$o/orientation.orig" 2>/dev/null || echo absent > "$o/orientation.orig"
fi
defaults write com.apple.dock orientation -string {{pos.start}}
killall Dock
