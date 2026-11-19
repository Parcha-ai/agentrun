#!/bin/sh
# Renders deploy/helm/agentrun without a cluster (helm install --dry-run=client, which renders NOTES too) and checks that
# the address the server gets as AGENTRUN_PUBLIC_URL is the one NOTES prints: from env.AGENTRUN_PUBLIC_URL, else the
# ingress host, else none; and that NOTES says so when the ingress's overrides one in existingSecret. CI's helm-walk job
# runs it before the walk. Needs helm.
set -eu
chart="$(cd "$(dirname "$0")" && pwd)/agentrun"
failed=0

# case <label> <want, or - for none> [helm --set flags...]
case_() {
  label=$1 want=$2
  shift 2
  out=$(helm install r "$chart" --dry-run=client "$@")
  env=$(printf '%s\n' "$out" | sed -n '/- name: AGENTRUN_PUBLIC_URL$/{n;s/^ *value: "\(.*\)"$/\1/p;}')
  notes=$(printf '%s\n' "$out" | sed -n '/^Open the console:$/{n;s/^ *//p;}')
  if [ "$want" = - ]; then
    if [ -n "$env" ]; then echo "FAIL $label: AGENTRUN_PUBLIC_URL is $env, want none" >&2; failed=1; return; fi
    echo "ok   $label: no AGENTRUN_PUBLIC_URL; NOTES: $notes"
    return
  fi
  if [ "$env" != "$want" ] || [ "$notes" != "$want" ]; then
    echo "FAIL $label: AGENTRUN_PUBLIC_URL '$env', NOTES '$notes', want both $want" >&2
    failed=1
    return
  fi
  echo "ok   $label: AGENTRUN_PUBLIC_URL and NOTES both $want"
}

case_ "no ingress" -
case_ "ingress, no TLS" http://agentrun.example/ --set ingress.enabled=true --set ingress.host=agentrun.example
case_ "ingress with TLS" https://agentrun.example/ --set ingress.enabled=true --set ingress.host=agentrun.example --set ingress.tlsSecret=tls
case_ "env wins over the ingress" https://agents.example.com/ --set ingress.enabled=true --set ingress.host=agentrun.example --set-string env.AGENTRUN_PUBLIC_URL=https://agents.example.com/
case_ "env, no ingress" https://agents.example.com/ --set-string env.AGENTRUN_PUBLIC_URL=https://agents.example.com/

# override <label> <want: yes or no> [helm --set flags...]: whether NOTES says the ingress's address overrides the Secret's.
override() {
  label=$1 want=$2
  shift 2
  if helm install r "$chart" --dry-run=client "$@" | grep -q 'overrides any AGENTRUN_PUBLIC_URL in Secret'; then said=yes; else said=no; fi
  if [ "$said" != "$want" ]; then echo "FAIL $label: NOTES names the Secret's address: $said, want $want" >&2; failed=1; return; fi
  echo "ok   $label: NOTES names the Secret's address: $said"
}
ingress="--set ingress.enabled=true --set ingress.host=agentrun.example"
# shellcheck disable=SC2086 # $ingress is the flags, split on purpose
{
  override "existingSecret and the ingress" yes $ingress --set existingSecret=keys
  override "existingSecret, the ingress and env" no $ingress --set existingSecret=keys --set-string env.AGENTRUN_PUBLIC_URL=https://agents.example.com/
  override "the ingress, the chart's Secret" no $ingress
}
exit "$failed"
