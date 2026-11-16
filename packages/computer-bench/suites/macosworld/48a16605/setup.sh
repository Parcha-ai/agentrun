# Note the start time and move a TODO.txt the Desktop already has aside, once (a retried setup keeps the first of
# each), then write this run's TODO.txt. Teardown puts the Mac's own file back.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Desktop/TODO.txt"
mkdir -p "$o" || exit 1
[ -f "$o/t0" ] || date +%s > "$o/t0"
if [ ! -f "$o/moved" ]; then
	if [ -e "$f" ]; then mv "$f" "$o/TODO.txt.orig" || exit 1; fi
	touch "$o/moved"
fi
printf '%s\n' "- {{todo.a}}" "- {{todo.b}}" "- {{todo.c}}" "- {{todo.d}}" > "$f" || exit 1
osascript -e 'if application id "com.apple.reminders" is running then tell application id "com.apple.reminders" to quit'
sleep 1
