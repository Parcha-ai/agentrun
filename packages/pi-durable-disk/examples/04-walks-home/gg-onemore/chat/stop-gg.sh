#!/bin/bash
# Stop the Golden Gate chat page (chat/live-gg.mjs): only what it started, through its own pid file in ~/tmp-gg-chat. Its stop
# first keeps the take's evidence in ~/tmp-gg-chat/takes/<time>/ (guard log, strength record, page events, the run's
# transcript), then tears down. If it is gone already, whatever is left of the page's own Modal app goes too. The last line
# counts that app's sandboxes: 0.
set -u
H=~/tmp-gg-chat
G=$(cd "$(dirname "$0")/.." && pwd)
B=~/evals/agentrun-archil-tl/bin
export PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH
PID=$(cat "$H/live-gg.pid" 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  # its stop keeps the take's evidence (~1 min) before it tears down
  for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 2; done
  if kill -0 "$PID" 2>/dev/null; then echo "live-gg (pid $PID) did not stop within 5 minutes"; fi
fi
rm -f "$H/secrets/guard-url" "$H/secrets/serve-key" "$H/secrets/tools-key" "$H/box-state/serve-key" "$H/box-state/exec-key"
if ! out=$(cd "$G" && "$B/with-modal" -- node chat/gg-sandboxes.mjs pda-gg-chat --terminate 2>&1); then
  echo "could not check pda-gg-chat's sandboxes: $(echo "$out" | tail -2 | tr '\n' ' ')"
  exit 1
fi
echo "$out" | tail -1
