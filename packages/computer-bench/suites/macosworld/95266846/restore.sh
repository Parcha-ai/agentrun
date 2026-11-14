# Close Script Editor's documents without saving and quit it, delete the run's sum.scpt, put back the one setup moved
# aside, and drop the copy. Only past setup's "moved" marker: a setup that failed before it never touched the Mac's own
# sum.scpt, so that file stays. A backup that can't be put back stays in the run's folder, and the teardown fails.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Documents/sum.scpt"
osascript -e 'if application id "com.apple.ScriptEditor2" is running then' -e 'tell application id "com.apple.ScriptEditor2"' -e 'close every document saving no' -e 'quit' -e 'end tell' -e 'end if'
[ -f "$o/moved" ] || exit 0
rm -f "$f"
if [ -e "$o/sum.scpt.orig" ]; then mv "$o/sum.scpt.orig" "$f" || exit 1; fi
rm -rf "$o"
