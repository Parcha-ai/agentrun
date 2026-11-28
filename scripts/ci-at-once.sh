#!/bin/sh
# CI's steps that run checks side by side: each argument is `label=command`, every command runs at once (sh -c), and
# every line it prints goes out as it comes, prefixed with its label ("[label] ..."), so lines that interleave stay
# attributed. Each command's exit and time are printed when it ends. Once all have ended, each that failed is named, in
# an error annotation of its own, and the step fails if any did; one failing never stops the others.
#   sh scripts/ci-at-once.sh 'one=sh a.sh' 'two=sh b.sh --two'
# A label is letters, digits and dashes, each one once.
set -eu
[ "$#" -gt 0 ] || { echo "usage: ci-at-once.sh label=command..." >&2; exit 2; }
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
labels=
for job in "$@"; do
  label=${job%%=*}
  case $label in
    "$job" | "" | *[!A-Za-z0-9-]*) echo "not label=command, with a label of letters, digits and dashes: $job" >&2; exit 2 ;;
  esac
  case " $labels " in *" $label "*) echo "label $label given twice" >&2; exit 2 ;; esac
  labels="$labels $label"
done
for job in "$@"; do
  label=${job%%=*}
  (
    start=$(date +%s%3N)
    { rc=0; sh -c "${job#*=}" 2>&1 || rc=$?; echo "$rc" >"$out/$label.rc"; } | sed -u "s/^/[$label] /"
    echo "[$label] exit $(cat "$out/$label.rc") after $(($(date +%s%3N) - start)) ms"
  ) &
done
wait
failed=
for label in $labels; do
  rc=$(cat "$out/$label.rc" 2>/dev/null || echo "none")
  [ "$rc" = 0 ] || { echo "::error::$label failed (exit $rc)"; failed="$failed $label"; }
done
[ -z "$failed" ] || { echo "failed:$failed" >&2; exit 1; }
echo "all passed:$labels"
