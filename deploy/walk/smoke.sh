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
claimed=$(api claimed "$run")
pass "run claimed" "$run by $(get "$claimed" claim.runner), epoch $(get "$claimed" claim.epoch)"
ended_once "run completed, each step once" "$(api end "$run")" 3
