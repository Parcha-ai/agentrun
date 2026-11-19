# The walks' shared part (sourced by smoke.sh and reclaim.sh): deploy/compose.yaml with the walk overlay, as a compose
# project of its own with its own volume, a seal key made for it, and everything removed on exit. Rows and the report are
# rows.sh's.
#   AGENTRUN_IMAGE=<image>   the image to walk; unset, the walk builds this checkout's as agentrun-walk:local.
set -eu
walk=$(cd "$(dirname "$0")" && pwd)
deploy=$(dirname "$walk")
project="agentrun-walk-$$"
work=$(mktemp -d)
rows="$work/rows"
: >"$rows"
umask 077
printf 'AGENTRUN_SEAL_KEY=%s\n' "$(openssl rand -base64 32)" >"$work/env"
umask 022
export AGENTRUN_IMAGE="${AGENTRUN_IMAGE:-agentrun-walk:local}"

dc() { docker compose -p "$project" --env-file "$work/env" -f "$deploy/compose.yaml" -f "$walk/compose.walk.yaml" "$@"; }
api() { dc exec -T server node /walk/api.mjs "$@"; }
. "$walk/rows.sh"
finish() {
  code=$?
  trap - EXIT INT TERM
  [ "$code" = 0 ] || { echo "--- the stack's log tail, on failure:" >&2; dc logs --no-color --tail 60 >&2 || true; }
  report "$code"
  dc down -v --remove-orphans --timeout 40 >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM

# Waits until `docker compose logs <service>` holds a line matching <pattern> <n> times (default 1), at most 60 s.
logged() {
  service=$1 pattern=$2 n=${3:-1} tries=0
  while [ "$(dc logs --no-log-prefix --no-color "$service" 2>/dev/null | grep -Ec "$pattern" || true)" -lt "$n" ]; do
    tries=$((tries + 1))
    [ "$tries" -le 240 ] || return 1
    sleep 0.25
  done
}

# Builds the image when none was given, starts the stack, and checks the server is healthy and each runner said it is
# ready in its one line.
walk_up() {
  if [ "$AGENTRUN_IMAGE" = agentrun-walk:local ]; then
    dc build server >"$work/build.log" 2>&1 || { tail -40 "$work/build.log" >&2; fail "image built" "docker compose build failed (its tail is above)"; }
    pass "image built" "this checkout's packages/serve/docker/Dockerfile as $AGENTRUN_IMAGE"
  fi
  dc up -d --wait --wait-timeout 180 >"$work/up.log" 2>&1 || { cat "$work/up.log" >&2; fail "stack up" "docker compose up --wait did not see every service healthy within 180 s"; }
  pass "server healthy" "$(dc ps --format '{{.Service}}: {{.Status}}' | tr '\n' ';' | sed 's/;$//; s/;/; /g')"
  for r in runner-1 runner-2; do
    logged "$r" "^Runner $r ready: store [a-z]+ schema v[0-9]+, [0-9]+ loops\$" || fail "$r ready" "no ready line from $r within 60 s"
    pass "$r ready" "$(dc logs --no-log-prefix --no-color "$r" | grep -E "^Runner $r ready" | tail -1)"
    # Its memory budget is its own container's limit (compose.yaml's mem_limit) less the 128 MiB a process keeps, never
    # the whole host's: the host's memory as the container sees it (os.totalmem, as the runner reads it) caps it.
    limit=$(docker inspect -f '{{.HostConfig.Memory}}' "$(dc ps -q "$r")")
    [ "${limit:-0}" -gt 0 ] || fail "$r memory" "its container has no memory limit (compose.yaml's mem_limit)"
    host=$(dc exec -T "$r" /usr/local/bin/node -p 'require("node:os").totalmem()')
    if [ "$limit" -lt "$host" ]; then want=$((limit / 1048576 - 128)); else want=$((host / 1048576 - 128)); fi
    logged "$r" "^Runner $r memory: $want MiB for runs" || fail "$r memory" "no line saying $want MiB for runs (its limit $limit bytes): $(dc logs --no-log-prefix --no-color "$r" | grep -E "^Runner $r memory" | tail -1)"
    pass "$r memory" "$(dc logs --no-log-prefix --no-color "$r" | grep -E "^Runner $r memory" | tail -1) (its container's limit $limit bytes)"
  done
}
