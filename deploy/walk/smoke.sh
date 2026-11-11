#!/bin/sh
# The deploy smoke (CI's deploy-compose job): deploy/compose.yaml's server and two runners from one image, on the faux
# model (compose.walk.yaml). The server is healthy, each runner says it is ready, and a run of an agent in the runner's
# place completes, each of its steps done once. Needs docker with compose, node and openssl.
#   deploy/walk/smoke.sh                          builds this checkout's image
#   AGENTRUN_IMAGE=<image> deploy/walk/smoke.sh   walks a built one
#   REPORT=<file>                                 the report in that file too
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

walk_up
agent=$(get "$(api agent)" agent)
pass "agent made" "$agent: pi, place runner, tool write"
run=$(get "$(api start "$agent" 3 0)" run)
# The claim as its runner records it ("Runner <name> claimed <run> (epoch <n>)"), not a poll of the run: a run of 0 ms
# steps can complete between two polls, its claim already let go, and a poll then never sees it held.
tries=0
until claim=$(dc logs --no-log-prefix --no-color runner-1 runner-2 2>/dev/null | grep -E "^Runner [^ ]+ claimed $run " | head -1) && [ -n "$claim" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 480 ] || fail "run claimed" "no runner logged a claim of $run within 120 s"
  sleep 0.25
done
pass "run claimed" "$claim"
ended_once "run completed, each step once" "$(api end "$run")" 3
