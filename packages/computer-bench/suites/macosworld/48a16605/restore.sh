# Delete the run's TODO.txt, put back the one setup moved aside, quit Reminders and TextEdit, and drop the copies.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Desktop/TODO.txt"
osascript -e 'if application id "com.apple.reminders" is running then tell application id "com.apple.reminders" to quit'
osascript -e 'if application id "com.apple.TextEdit" is running then' -e 'tell application id "com.apple.TextEdit"' -e 'close every document saving no' -e 'quit' -e 'end tell' -e 'end if'
rm -f "$f"
if [ -e "$o/TODO.txt.orig" ]; then mv "$o/TODO.txt.orig" "$f"; fi
rm -rf "$o"
true
