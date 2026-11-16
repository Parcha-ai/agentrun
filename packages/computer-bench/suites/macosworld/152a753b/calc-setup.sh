# Keep the Mac's own last Calculator result once (a retried setup keeps the first copy), quit Calculator, and clear the
# result, so only this run's work can set it.
o="/tmp/computer-bench-{{nonce}}"
mkdir -p "$o" || exit 1
osascript -e 'if application id "com.apple.calculator" is running then tell application id "com.apple.calculator" to quit'
i=0
while pgrep -x Calculator > /dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
if [ ! -f "$o/last.orig" ]; then
	defaults read com.apple.calculator LastResultValue > "$o/last.orig" 2> /dev/null || echo absent > "$o/last.orig"
fi
defaults delete com.apple.calculator LastResultValue 2> /dev/null
true
