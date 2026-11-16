# Quit Reminders and TextEdit, delete the run's TODO.txt, put back the one setup moved aside, and drop the copies.
# Only past setup's "moved" marker: a setup that failed before it wrote nothing over the Mac's own TODO.txt, so that file
# stays. A backup that can't be put back stays in the run's folder, and the teardown fails.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Desktop/TODO.txt"
osascript -e 'if application id "com.apple.reminders" is running then tell application id "com.apple.reminders" to quit'
osascript -e 'if application id "com.apple.TextEdit" is running then' -e 'tell application id "com.apple.TextEdit"' -e 'close every document saving no' -e 'quit' -e 'end tell' -e 'end if'
[ -f "$o/moved" ] || exit 0
rm -f "$f"
if [ -e "$o/TODO.txt.orig" ]; then mv "$o/TODO.txt.orig" "$f" || exit 1; fi
rm -rf "$o"
