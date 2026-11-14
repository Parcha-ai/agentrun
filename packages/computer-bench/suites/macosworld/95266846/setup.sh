# Move a sum.scpt the Mac already has in Documents aside once (a retried setup keeps the first copy), so the file the
# check runs can only be the agent's; teardown puts it back.
o="/tmp/computer-bench-{{nonce}}"
f="$HOME/Documents/sum.scpt"
mkdir -p "$o" || exit 1
if [ ! -f "$o/moved" ]; then
	if [ -e "$f" ]; then mv "$f" "$o/sum.scpt.orig" || exit 1; fi
	touch "$o/moved"
fi
rm -f "$f"
