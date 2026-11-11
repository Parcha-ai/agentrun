#!/bin/sh
# The deploy smoke (CI's deploy-compose job): deploy/compose.yaml's server and two runners from one image, on the faux
# model (compose.walk.yaml). The server is healthy, each runner says it is ready, and a run of an agent in the runner's
# place is claimed once and completes, each of its steps done once. Needs docker with compose, node and openssl.
#   deploy/walk/smoke.sh                          builds this checkout's image
#   AGENTRUN_IMAGE=<image> deploy/walk/smoke.sh   walks a built one
#   REPORT=<file>                                 the report in that file too
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

walk_up
agent=$(get "$(api agent)" agent)
pass "agent made" "$agent: pi, place runner, tool write"
run=$(get "$(api start "$agent" 3 0)" run)
# The run's three 0 ms steps can end within a second, before any poll sees a runner hold it, so the walk waits for its
# end and reads its claim from the runner's own record of it ("Runner <name> claimed <run> (epoch <n>)"), not from a
# live claim a fast run slips past, and holds it to one claim.
ended=$(api end "$run")
claims=$(claims_of "$run") || fail "run claimed" "no runner recorded a claim of $run within 60 s of its end"
[ "$(printf '%s\n' "$claims" | wc -l)" -eq 1 ] || fail "run claimed" "claimed more than once: $(printf '%s' "$claims" | tr '\n' ';')"
pass "run claimed" "$run by $(printf '%s' "$claims" | sed -E 's/^Runner ([^ ]+) claimed [^ ]+ \(epoch ([0-9]+)\)$/\1, epoch \2/')"
ended_once "run completed, each step once" "$ended" 3
