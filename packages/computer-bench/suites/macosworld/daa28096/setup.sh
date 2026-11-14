# Keep Music's own volume once (a retried setup keeps the first copy), then start it at 100 and bring Music to the front.
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o" || exit 1
if [ ! -f "$o/volume.orig" ]; then
	osascript -e 'tell application "Music" to get sound volume' > "$o/volume.orig" || exit 1
fi
osascript -e 'tell application "Music" to set sound volume to 100' -e 'tell application "Music" to activate'
