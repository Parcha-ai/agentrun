# budget.txt in Documents/computer-bench-{{nonce}}, made fresh, with a pristine copy under /tmp for the checks; TextEdit
# opens it.
set -e
d="$HOME/Documents/computer-bench-{{nonce}}"
o="/tmp/computer-bench-{{nonce}}"
rm -rf "$d" "$o"
mkdir -p "$d" "$o"
printf 'Monthly budget {{nonce}}\nRent: 2100\nFood: 1450\nPower: 1180\nTravel: 1320\n' > "$o/budget.orig"
cp "$o/budget.orig" "$d/budget.txt"
open -a TextEdit "$d/budget.txt"
