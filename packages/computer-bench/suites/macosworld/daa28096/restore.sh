# Put Music's own volume back when setup kept it, quit Music, and drop the copy.
o="/tmp/computer-bench-{{nonce}}"
v=$(cat "$o/volume.orig" 2> /dev/null)
case "$v" in
	'' | *[!0-9]*) ;;
	*) osascript -e "tell application \"Music\" to set sound volume to $v" ;;
esac
osascript -e 'if application id "com.apple.Music" is running then tell application id "com.apple.Music" to quit'
rm -rf "$o"
true
