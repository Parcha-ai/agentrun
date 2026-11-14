# Quit Calculator, put back the last result setup kept (no key at all when the Mac had none), and drop the copy.
o="/tmp/computer-bench-{{nonce}}"
osascript -e 'if application id "com.apple.calculator" is running then tell application id "com.apple.calculator" to quit'
i=0
while pgrep -x Calculator > /dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
v=$(cat "$o/last.orig" 2> /dev/null || echo absent)
if [ "$v" = absent ]; then
	defaults delete com.apple.calculator LastResultValue 2> /dev/null
else
	defaults write com.apple.calculator LastResultValue -string "$v"
fi
rm -rf "$o"
true
