# The folder computer-bench-{{nonce}} in Documents holds the file to rename and one other, made fresh; a Finder window
# shows it.
set -e
d="$HOME/Documents/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
printf '%s\n' "{{doc.body}}" > "$d/{{doc.old}}.txt"
printf '%s\n' "Leave this file as it is." > "$d/readme.txt"
open "$d"
