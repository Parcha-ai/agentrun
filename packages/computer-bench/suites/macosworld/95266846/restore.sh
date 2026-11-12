# Close Script Editor's documents without saving and quit it, delete the run's sum.scpt, put back the one setup moved
# aside, and drop the copy.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Documents/sum.scpt"
osascript -e 'if application id "com.apple.ScriptEditor2" is running then' -e 'tell application id "com.apple.ScriptEditor2"' -e 'close every document saving no' -e 'quit' -e 'end tell' -e 'end if'
rm -f "$f"
if [ -e "$o/sum.scpt.orig" ]; then mv "$o/sum.scpt.orig" "$f"; fi
rm -rf "$o"
true
