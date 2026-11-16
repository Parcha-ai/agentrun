# The folder computer-bench-{{nonce}} in Documents holds three untagged text files, made fresh; a Finder window shows it.
set -e
d="$HOME/Documents/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
printf 'Plan for the quarter\n' > "$d/plan.txt"
printf 'Budget, first draft\n' > "$d/budget.txt"
printf 'Ideas worth trying\n' > "$d/ideas.txt"
open "$d"
