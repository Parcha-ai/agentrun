# The invitation page under /tmp/computer-bench-{{nonce}}: the event's title, tomorrow's date written out (from the
# Mac's clock when setup runs), the time, and a doors-open time that is not the event's start.
set -e
d="/tmp/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
day=$(date -v+1d '+%A, %B %e' | tr -s ' ')
cat > "$d/invite.html" <<PAGE
<!doctype html><html><head><meta charset="utf-8"><title>You're invited: {{title}} {{nonce}}</title></head>
<body>
<h1>{{title}} {{nonce}}</h1>
<p>You're invited.</p>
<p><b>When:</b> $day, {{slot.say}}</p>
<p><b>Where:</b> {{where}}</p>
<p>Doors open half an hour early. Bring a friend.</p>
</body></html>
PAGE
