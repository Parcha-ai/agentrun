# The walks' rows and report (sourced by lib.sh, for smoke.sh and reclaim.sh, and by deploy/helm/walk.sh): each step is a
# row, `step | PASS or FAIL | evidence`, in "$rows"; the first FAIL ends the walk. At the end the report: a Verdict line,
# then the rows, on stdout and, with REPORT=<file>, in that file too. The sourcing walk sets work (its temporary folder)
# and rows, and runs report from its exit trap. Needs node.
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
