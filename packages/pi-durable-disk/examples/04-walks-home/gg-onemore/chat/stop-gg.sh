#!/bin/bash
# Stop a chat page (chat/live-gg.mjs): only what it started, through its own pid file in its home (~/tmp-gg-chat, or
# ~/tmp-steer with --page any). Its stop first keeps the take's evidence in <home>/takes/<time>/ (guard log, strength record,
# the served edit and the recipes made, page events, the run's transcript), then tears down. If it is gone already, whatever
# is left of the page's own Modal app goes too. The last line counts that app's sandboxes: 0.
# With --keep-box everything but the GPU box goes (SIGUSR2), for a fresh chat on it: live-gg.mjs --reuse-box.
#   chat/stop-gg.sh [--page golden-gate|any] [--keep-box]
set -u
H=~/tmp-gg-chat APP=pda-gg-chat KEEP=
while [ $# -gt 0 ]; do
  case "$1 ${2:-}" in
    "--page any") H=~/tmp-steer APP=pda-steer; shift 2 ;;
    "--page golden-gate") shift 2 ;;
    "--keep-box "*) KEEP=1; shift ;;
    *) echo "usage: chat/stop-gg.sh [--page golden-gate|any] [--keep-box]"; exit 2 ;;
  esac
done
G=$(cd "$(dirname "$0")/.." && pwd)
B=~/evals/agentrun-archil-tl/bin
export PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH
PID=$(cat "$H/live-gg.pid" 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "-$([ -n "$KEEP" ] && echo USR2 || echo TERM)" "$PID"
  # its stop keeps the take's evidence (~1 min) before it tears down
  for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 2; done
  if kill -0 "$PID" 2>/dev/null; then echo "live-gg (pid $PID) did not stop within 5 minutes"; fi
fi
rm -f "$H/secrets/guard-url" "$H/secrets/serve-key" "$H/secrets/tools-key"
SPARE=()
if [ -n "$KEEP" ]; then
  # the kept box's keys stay with it (box-state/), for the next page
  SPARE=(--keep "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("sandbox", ""))' "$H/box-state/box.json" 2>/dev/null)")
else
  rm -f "$H/box-state/serve-key" "$H/box-state/exec-key"
fi
if ! out=$(cd "$G" && "$B/with-modal" -- node chat/gg-sandboxes.mjs "$APP" --terminate "${SPARE[@]}" 2>&1); then
  echo "could not check $APP's sandboxes: $(echo "$out" | tail -2 | tr '\n' ' ')"
  exit 1
fi
echo "$out" | tail -1
