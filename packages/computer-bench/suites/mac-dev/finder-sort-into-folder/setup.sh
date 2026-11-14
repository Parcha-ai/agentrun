# The folder computer-bench-{{nonce}} in Documents holds six files of three kinds, made fresh; a Finder window shows it.
set -e
d="$HOME/Documents/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
printf 'month,total\njan,410\n' > "$d/jan.csv"
printf 'month,total\nfeb,385\n' > "$d/feb.csv"
printf 'Ideas for the offsite\n' > "$d/notes.txt"
printf 'Renew the passport\n' > "$d/todo.txt"
printf 'run 1 ok\n' > "$d/run.log"
printf 'build 7 ok\n' > "$d/build.log"
open "$d"
