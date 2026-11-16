# handover.txt in Documents/computer-bench-{{nonce}}, made fresh, with five lines; TextEdit opens it.
set -e
d="$HOME/Documents/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
printf 'Handover for the weekend\nDoor code: 4417\nWi-Fi password: maple-river-82\nAlarm PIN: 9023\nParking spot: B14\n' > "$d/handover.txt"
open -a TextEdit "$d/handover.txt"
