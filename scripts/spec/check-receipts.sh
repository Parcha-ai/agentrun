#!/usr/bin/env bash
# Model-checks the recovery driver's effects (spec/receipts/Receipts.tla) with TLC.
#
#   Receipts.cfg       every property: two call steps, two crashes and failing commits.
#   ReceiptsFull.cfg   every property at larger bounds: six call steps and six crashes.
#   Receipts_<P>.cfg   a property with a known counterexample (a finding with its node test); must still
#                      be violated, by exactly that property. When a fix lands, the config stops failing,
#                      this script says so, and the property moves into the configs above.
#
# The held configs run concurrently, each on its share of the CPUs: most of a run is the liveness
# check, which TLC does largely on one thread.
#
# Each TLC invocation has a wall-clock limit, TLC_TIMEOUT_S (default 300 s). A config that has not
# finished by then is stopped and fails by name, so a stalled JVM ends the check in minutes instead of
# running out the job's timeout.
#
# Env: TLA2TOOLS (the path of tla2tools.jar, required), TLC_WORKERS (workers per config; default the
#      CPUs divided among the concurrent configs), TLC_OUT (where each run's log and trace go;
#      default a temp dir), TLC_JAVA_OPTS, TLC_TIMEOUT_S.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
spec="$root/spec/receipts"
jar="${TLA2TOOLS:-}"
out="${TLC_OUT:-$(mktemp -d -t receipts-tlc-XXXXXX)}"
mkdir -p "$out"
[ -n "$jar" ] && [ -f "$jar" ] || { echo "tla2tools.jar not found${jar:+ at $jar}: set TLA2TOOLS to its path" >&2; exit 2; }

holds=(Receipts.cfg ReceiptsFull.cfg)
cpus="$(nproc 2>/dev/null || echo 2)"
share=$(( cpus / ${#holds[@]} )); [ "$share" -ge 1 ] || share=1
workers="${TLC_WORKERS:-$share}"
# Each JVM takes an even share of the memory the default heap would give one of them.
heap_mb=$(( $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 4096) / 2 / ${#holds[@]} ))
limit="${TLC_TIMEOUT_S:-300}"
limit_of() { echo "$limit"; }

tlc() { # config -> runs TLC on a private copy so its states/ directory never lands in the tree
  local cfg="$1" dir="$out/${1%.cfg}" rc=0 cap began
  cap="$(limit_of "$1")"; began=$(date +%s)
  rm -rf "$dir"; mkdir -p "$dir/tmp"
  cp "$spec/Receipts.tla" "$spec/$cfg" "$dir/"
  # A private java.io.tmpdir: TLC unpacks its standard modules there, and concurrent runs sharing
  # one directory read each other's half-written files. timeout sends TERM at the limit and KILL
  # 10 s later, so a stopped run exits 124 or 137; a 137 before the limit is some other kill.
  (cd "$dir" && timeout --kill-after=10 "$cap" java ${TLC_JAVA_OPTS:--XX:+UseParallelGC -Xmx${heap_mb}m} -Djava.io.tmpdir="$dir/tmp" -cp "$jar" tlc2.TLC -workers "$workers" \
     -config "$cfg" -metadir "$dir/states" Receipts.tla) > "$dir/tlc.log" 2>&1 || rc=$?
  if { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ $(( $(date +%s) - began )) -ge "$cap" ]; then echo "$cap" > "$dir/timed-out"; fi
}
# config -> prints the stall failure and returns 0 when that config's TLC hit the limit.
stalled() {
  local dir="$out/${1%.cfg}"
  [ -f "$dir/timed-out" ] || return 1
  echo "FAIL $1: TLC did not finish within $(cat "$dir/timed-out")s and was stopped (a stalled model check). Log: $dir/tlc.log" >&2
  tail -20 "$dir/tlc.log" >&2
}

status=0
started=$(date +%s)
pids=()
for cfg in "${holds[@]}"; do tlc "$cfg" & pids+=($!); done
wait "${pids[@]}"
for cfg in "${holds[@]}"; do
  log="$out/${cfg%.cfg}/tlc.log"
  if stalled "$cfg"; then
    status=1
  elif grep -q "Model checking completed. No error has been found." "$log"; then
    echo "ok   $cfg: $(grep -E '^[0-9]+ states generated' "$log" | tail -1) ($(grep -oE 'Finished in .*' "$log" | head -1))"
  else
    echo "FAIL $cfg: a property that held is violated, or TLC did not finish. Log: $log" >&2
    grep -E "^Error|violated" "$log" >&2 || tail -20 "$log" >&2
    status=1
  fi
done

for cfg in $(cd "$spec" && ls Receipts_*.cfg 2>/dev/null); do
  property="$(grep -E '^(INVARIANT|PROPERTY) ' "$spec/$cfg" | awk '{print $2}')"
  tlc "$cfg"; log="$out/${cfg%.cfg}/tlc.log"
  if stalled "$cfg"; then
    status=1
  elif grep -qE "^Error: (Invariant|Action property) ${property} is violated" "$log"; then
    echo "ok   $cfg: $property still has its counterexample (trace: $log)"
  elif grep -q "Model checking completed. No error has been found." "$log"; then
    echo "FAIL $cfg: $property now holds. Move it into the held configs, delete $cfg and remove the todo from its test." >&2
    status=1
  else
    echo "FAIL $cfg: TLC did not report the expected violation of $property. Log: $log" >&2
    grep -E "^Error" "$log" >&2 || tail -20 "$log" >&2
    status=1
  fi
done
echo "receipts spec: $(( $(date +%s) - started ))s on $cpus CPUs, $workers workers per config, ${limit}s limit per config, logs in $out"
exit $status
