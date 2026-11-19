#!/bin/sh
# The Helm walk (CI's helm-walk job): deploy/helm/agentrun on the cluster kubectl points at (kind in CI), with the
# chart's own image, on the faux model of deploy/walk/faux-steps.mjs (no key, no network) and the counts off
# (walk-values.yaml). It installs and waits for ready, checks what the chart made (the keys, the data directory, each
# run's own user, the memory the runner budgets), runs a first run to completed, upgrades onto a new pod and checks the
# keys and the run were kept. It uninstalls and checks the Secret and the volume were kept (keepOnUninstall), installs
# again under the same name and checks the first run is still listed with the same token, then uninstalls, deletes the
# kept Secret and volume, and checks nothing of the release is left. Needs helm, kubectl, node and a cluster with a
# default StorageClass. REPORT=<file> puts the report in that file too.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
walk=$(dirname "$here")/walk
ns=agentrun-walk
release=agentrun
# The walk's own namespace: it refuses one that is there already, so its cleanup never deletes what it didn't make.
kubectl create namespace "$ns" >/dev/null || {
  echo "walk.sh: namespace $ns is there already (another walk, or what one left): delete it, then walk again" >&2
  exit 1
}
work=$(mktemp -d)
rows="$work/rows"
: >"$rows"
. "$walk/rows.sh"

k() { kubectl -n "$ns" "$@"; }
in_pod() { k exec "deploy/$release" -c agentrun -- "$@"; }
api() { in_pod env WALK_BASE=http://127.0.0.1:7340/v2 node /walk/api.mjs "$@"; }
pod() { k get pod -l "app.kubernetes.io/instance=$release" -o jsonpath='{.items[0].metadata.name}'; }
# The Secret's data, hashed: compared across the upgrade, never printed.
keys_hash() { k get secret "$release" -o jsonpath='{.data}' | sha256sum | cut -c1-16; }
# What of the release is left in its namespace, and any volume still bound to a claim there.
left() {
  k get all,pvc,secret,configmap,ingress -l "app.kubernetes.io/instance=$release" -o name
  kubectl get pv -o jsonpath="{range .items[?(@.spec.claimRef.namespace==\"$ns\")]}pv/{.metadata.name}{\"\\n\"}{end}"
}

finish() {
  code=$?
  trap - EXIT INT TERM
  if [ "$code" != 0 ]; then
    echo "--- the release's pods and log tail, on failure:" >&2
    k get pods -o wide >&2 || true
    k describe pods -l "app.kubernetes.io/instance=$release" 2>/dev/null | tail -30 >&2 || true
    k logs "deploy/$release" -c agentrun --tail 60 >&2 || true
  fi
  report "$code"
  helm uninstall "$release" -n "$ns" --wait >/dev/null 2>&1 || true
  k delete secret,pvc -l "app.kubernetes.io/instance=$release" >/dev/null 2>&1 || true
  kubectl delete namespace "$ns" --wait=false >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM

k create configmap walk-files --from-file="$walk/faux-steps.mjs" --from-file="$walk/api.mjs" >/dev/null
helm install "$release" "$here/agentrun" -n "$ns" -f "$here/walk-values.yaml" --wait --timeout 5m >"$work/install.log" 2>&1 \
  || { cat "$work/install.log" >&2; fail "installed" "helm install --wait: $(tail -1 "$work/install.log")"; }
first=$(pod)
grace=$(k get pod "$first" -o jsonpath='{.spec.terminationGracePeriodSeconds}')
[ "$grace" = 35 ] || fail "installed" "the pod's stop grace is ${grace}s, not 35 s (the 6 s drain and the runner's 25 s)"
pass "installed" "$(k get pod "$first" -o jsonpath='{.metadata.name} {.status.phase}, image {.spec.containers[0].image}'), stop grace ${grace}s"

token=$(k get secret "$release" -o jsonpath='{.data.AGENTRUN_TOKEN}' | base64 -d | wc -c)
seal=$(k get secret "$release" -o jsonpath='{.data.AGENTRUN_SEAL_KEY}' | base64 -d | base64 -d | wc -c)
if [ "$token" != 64 ] || [ "$seal" != 32 ]; then
  fail "keys made" "AGENTRUN_TOKEN $token characters (not 64), AGENTRUN_SEAL_KEY $seal bytes (not 32)"
fi
pass "keys made" "Secret $release: AGENTRUN_TOKEN $token characters, AGENTRUN_SEAL_KEY base64 of $seal bytes"

data=$(in_pod stat -c '%U:%G %a' /data)
[ "$data" = "node:node 711" ] || fail "data directory" "/data is $data, not node:node 711 (the image's: a run crosses it without listing it)"
pass "data directory" "/data on the volume is $data"

isolation=$(get "$(api isolation)" run_isolation)
[ "$isolation" = uid ] || fail "run user" "run_isolation is $isolation, not uid: each run is not a user of its own"
pass "run user" "run_isolation $isolation: each run's process is a user of its own"

tries=0
until budget=$(k logs "deploy/$release" -c agentrun | grep -E '^Runner [^ ]+ memory: [0-9]+ MiB for runs' | tail -1) && [ -n "$budget" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "runner memory" "no runner memory line within 30 s"
  sleep 0.5
done
case $budget in *" memory: 1920 MiB for runs"*) ;; *) fail "runner memory" "$budget, not 1920 MiB (the 2Gi limit less 128 MiB)" ;; esac
pass "runner memory" "$budget"

telemetry=$(in_pod printenv AGENTRUN_TELEMETRY || true)
[ "$telemetry" = 0 ] || fail "counts off" "AGENTRUN_TELEMETRY is '$telemetry', not 0"
pass "counts off" "AGENTRUN_TELEMETRY=0 in the pod"

agent=$(get "$(api agent)" agent)
run=$(get "$(api start "$agent" 3 0)" run)
ended_once "first run" "$(api end "$run")" 3

before=$(keys_hash)
helm upgrade "$release" "$here/agentrun" -n "$ns" -f "$here/walk-values.yaml" --set-string env.WALK_UPGRADED=1 --wait --timeout 5m >"$work/upgrade.log" 2>&1 \
  || { cat "$work/upgrade.log" >&2; fail "upgraded" "helm upgrade --wait: $(tail -1 "$work/upgrade.log")"; }
tries=0
while second=$(pod) && [ "$second" = "$first" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "upgraded" "the pod is still $first 30 s after the upgrade"
  sleep 0.5
done
pass "upgraded" "pod $first replaced by $second"
after=$(keys_hash)
[ "$after" = "$before" ] || fail "keys kept" "the Secret's data changed across the upgrade"
pass "keys kept" "the Secret's data is the same before and after (sha256 $after)"
kept=$(get "$(api run "$run")" status)
[ "$kept" = completed ] || fail "data kept" "the first run reads $kept on the new pod"
pass "data kept" "the first run reads $kept on the new pod"
again=$(get "$(api start "$agent" 2 0)" run)
ended_once "a run after the upgrade" "$(api end "$again")" 2

helm uninstall "$release" -n "$ns" --wait --timeout 3m >/dev/null
# helm uninstall --wait waits for what it deletes, not for the pod under them: the pod goes within its grace.
want="persistentvolumeclaim/$release pv/$(k get pvc "$release" -o jsonpath='{.spec.volumeName}') secret/$release"
tries=0
while kept=$(left | sort | tr '\n' ' ' | sed 's/ $//') && [ "$kept" != "$want" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 120 ] || fail "uninstall keeps" "60 s after helm uninstall: $kept (not the Secret, the claim and its volume alone)"
  sleep 0.5
done
pass "uninstall keeps" "helm uninstall left $kept"

helm install "$release" "$here/agentrun" -n "$ns" -f "$here/walk-values.yaml" --wait --timeout 5m >"$work/reinstall.log" 2>&1 \
  || { cat "$work/reinstall.log" >&2; fail "reinstalled" "helm install --wait: $(tail -1 "$work/reinstall.log")"; }
[ "$(keys_hash)" = "$before" ] || fail "reinstalled" "the Secret's data changed across the uninstall and install"
listed=$(get "$(api run "$run")" status)
[ "$listed" = completed ] || fail "reinstalled" "the first run reads $listed after the reinstall"
pass "reinstalled" "pod $(pod): the same Secret data (sha256 $before), and the first run reads $listed with the same token"

helm uninstall "$release" -n "$ns" --wait --timeout 3m >/dev/null
k delete secret "$release" >/dev/null
k delete pvc "$release" --wait=true >/dev/null
k delete configmap walk-files >/dev/null
tries=0
while [ -n "$(left)" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 120 ] || fail "uninstalled" "still there 60 s after helm uninstall: $(left | tr '\n' ' ')"
  sleep 0.5
done
pass "uninstalled" "after helm uninstall and deleting the kept Secret and claim: nothing labelled app.kubernetes.io/instance=$release in $ns, and no volume bound to a claim there"
