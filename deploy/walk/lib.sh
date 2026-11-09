# The walks' shared part (sourced by smoke.sh and reclaim.sh): deploy/compose.yaml with the walk overlay, as a compose
# project of its own with its own volume, a seal key made for it, and everything removed on exit. Each step is a row,
# `step | PASS or FAIL | evidence`; the first FAIL ends the walk. At the end the report: a Verdict line, then the rows,
# on stdout and, with REPORT=<file>, in that file too.
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
# A field of a JSON line, by a dotted path: get '{"a":{"b":1}}' a.b prints 1.
get() { printf '%s' "$1" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { let v = JSON.parse(s); for (const k of process.argv[1].split(".")) v = v?.[k]; console.log(typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)); });' "$2"; }

row() { printf '%s | %s | %s\n' "$1" "$2" "$3" >>"$rows"; printf '%s | %s | %s\n' "$1" "$2" "$3" >&2; }
pass() { row "$1" PASS "$2"; }
fail() {
  row "$1" FAIL "$2"
  exit 1
}
report() {
  if grep -q '| FAIL |' "$rows" || [ "${1:-0}" != 0 ]; then verdict=FAIL; else verdict=PASS; fi
  {
    echo "Verdict: $verdict"
    echo
    echo "| step | result | evidence |"
    echo "| --- | --- | --- |"
    sed 's/^/| /; s/$/ |/' "$rows"
  } >"$work/report"
  cat "$work/report"
  [ -z "${REPORT:-}" ] || cp "$work/report" "$REPORT"
}
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
  done
}

# Checks a run ended completed with steps 1..<n> each done exactly once: one write call per step in its timeline, and the
# files step-1.txt..step-<n>.txt in its work/.
ended_once() {
  label=$1 ended=$2 n=$3
  [ "$(get "$ended" status)" = completed ] || fail "$label" "the run ended $(get "$ended" status): $(get "$ended" error)"
  want_files=$(i=1; while [ "$i" -le "$n" ]; do printf 'step-%s.txt,' "$i"; i=$((i + 1)); done | sed 's/,$//')
  have_files=$(get "$ended" files | tr -d '[]"')
  [ "$have_files" = "$want_files" ] || fail "$label" "files $have_files, not $want_files"
  calls=$(get "$ended" steps.calls)
  want_calls=$(node -e 'const n = Number(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 1]))))' "$n")
  [ "$calls" = "$want_calls" ] || fail "$label" "write calls by step $calls, not $want_calls (each once)"
  [ "$(get "$ended" steps.answered)" = "$n" ] || fail "$label" "$(get "$ended" steps.answered) write results, not $n"
  pass "$label" "completed; write calls by step $calls, $n results; files $have_files"
}
