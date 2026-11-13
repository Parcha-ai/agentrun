#!/bin/sh
# The reclaim walk: a runner that stops in the middle of a run, and another runner that takes the run over. On
# deploy/compose.yaml's server and two runners, on the faux model (compose.walk.yaml): a run of 6 steps, each one the
# model takes 10 s to ask for, about 60 s in all.
#   1. SIGTERM: the runner holding the run is stopped once step 1 is done. It hands the run back as it closes (exit 0),
#      the other runner claims it under a higher epoch, and the run completes with each step done once.
#   2. SIGKILL: the same with a runner killed, which hands nothing back. The other runner claims the run once its claim
#      lapses, within the 30 s lease (plus the runner's 1 s claim poll and this walk's 0.25 s read), and the run completes
#      with each step done once.
# The holder is read from GET /v2/runs/{id}'s claim.runner. Needs docker with compose, node and openssl.
#   deploy/walk/reclaim.sh                          builds this checkout's image
#   AGENTRUN_IMAGE=<image> deploy/walk/reclaim.sh   walks a built one
#   REPORT=<file>                                   the report in that file too
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

STEPS=6
STEP_MS=10000
LEASE_MS=30000
SLACK_MS=1250

other() { if [ "$1" = runner-1 ]; then echo runner-2; else echo runner-1; fi; }
exit_code() { docker inspect --format '{{.State.ExitCode}}' "$(dc ps -a -q "$1")"; }
stopped() { docker wait "$(dc ps -a -q "$1")" >/dev/null; }

walk_up
agent=$(get "$(api agent)" agent)
pass "agent made" "$agent: pi, place runner, tool write; $STEPS steps of $STEP_MS ms a run"

# 1. SIGTERM.
run=$(get "$(api start "$agent" "$STEPS" "$STEP_MS")" run)
first=$(api claimed "$run")
holder=$(get "$first" claim.runner) epoch=$(get "$first" claim.epoch)
pass "SIGTERM: run claimed" "$run by $holder, epoch $epoch"
api step "$run" 1 >/dev/null
dc kill -s SIGTERM "$holder" >/dev/null 2>&1
stopped "$holder"
code=$(exit_code "$holder")
[ "$code" = 0 ] || fail "SIGTERM: $holder closed" "exit $code, not 0"
logged "$holder" "^Runner $holder released $run " || fail "SIGTERM: $holder closed" "exit 0, but no line saying it released $run"
pass "SIGTERM: $holder closed" "exit 0 after step 1; $(dc logs --no-log-prefix --no-color "$holder" | grep -E "^Runner $holder released $run " | tail -1)"
next=$(api claimed "$run" "$holder")
[ "$(get "$next" claim.runner)" = "$(other "$holder")" ] && [ "$(get "$next" claim.epoch)" -gt "$epoch" ] ||
  fail "SIGTERM: run reclaimed" "claim $(get "$next" claim), wanted $(other "$holder") above epoch $epoch"
pass "SIGTERM: run reclaimed" "by $(get "$next" claim.runner), epoch $(get "$next" claim.epoch) (was $holder, epoch $epoch)"
ended_once "SIGTERM: run completed, each step once" "$(api end "$run")" "$STEPS"

# Both runners again: the one stopped is started, and says it is ready a second time.
dc up -d --wait --wait-timeout 120 "$holder" >/dev/null 2>&1 || fail "$holder restarted" "not healthy again within 120 s"
logged "$holder" "^Runner $holder ready: " 2 || fail "$holder restarted" "no second ready line"
pass "$holder restarted" "healthy, and ready again: $(dc logs --no-log-prefix --no-color "$holder" | grep -E "^Runner $holder ready" | tail -1)"

# 2. SIGKILL.
run=$(get "$(api start "$agent" "$STEPS" "$STEP_MS")" run)
first=$(api claimed "$run")
holder=$(get "$first" claim.runner) epoch=$(get "$first" claim.epoch)
pass "SIGKILL: run claimed" "$run by $holder, epoch $epoch, until $(get "$first" claim.until)"
api step "$run" 1 >/dev/null
dc kill -s SIGKILL "$holder" >/dev/null 2>&1
killed_at=$(date +%s%3N)
stopped "$holder"
code=$(exit_code "$holder")
[ "$code" = 137 ] || fail "SIGKILL: $holder killed" "exit $code, not 137"
pass "SIGKILL: $holder killed" "exit 137 after step 1, nothing handed back"
next=$(api claimed "$run" "$holder")
took=$(($(get "$next" at) - killed_at))
[ "$(get "$next" claim.runner)" = "$(other "$holder")" ] && [ "$(get "$next" claim.epoch)" -gt "$epoch" ] ||
  fail "SIGKILL: run reclaimed" "claim $(get "$next" claim), wanted $(other "$holder") above epoch $epoch"
[ "$took" -le $((LEASE_MS + SLACK_MS)) ] || fail "SIGKILL: run reclaimed within the lease" "$took ms after the kill, over $LEASE_MS + $SLACK_MS"
pass "SIGKILL: run reclaimed within the lease" "by $(get "$next" claim.runner), epoch $(get "$next" claim.epoch), $took ms after the kill (lease $LEASE_MS ms + $SLACK_MS ms of polls)"
ended_once "SIGKILL: run completed, each step once" "$(api end "$run")" "$STEPS"
