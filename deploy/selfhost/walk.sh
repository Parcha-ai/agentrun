#!/bin/sh
# The Coolify and Dokploy walk (CI's selfhost-walk job): walk.sh coolify|dokploy installs that platform on this machine
# (a throwaway VM: it takes ports 80 and 443 and, for Dokploy, makes this Docker a swarm), deploys our template through
# the platform's own API so the platform makes the token, the seal key and the domain, and checks what it made: the
# keys, the public address and the platform's proxy reaching the server at it, the data directory, each run's own user,
# and a first run to completed on the faux model of deploy/walk/faux-steps.mjs (no key, no network; overlay.mjs, with
# the counts off). Then it removes the service and its volume through the platform's API and checks nothing is left.
# Needs sudo, docker, curl, jq and node with this checkout's node_modules. REPORT=<file> puts the report in that file too.
set -eu
platform=${1:?usage: walk.sh coolify|dokploy}
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(dirname "$here")
walk=$deploy/walk
work=$(mktemp -d)
rows="$work/rows"
: >"$rows"
. "$walk/rows.sh"
# The platform's part: install, deploy (sets container, the server's container, and host, its domain), remove, left
# (what of the service is still on this Docker) and logs; and version and template.
if [ "$platform" = coolify ]; then
  # shellcheck source=coolify.sh
  . "$here/coolify.sh"
elif [ "$platform" = dokploy ]; then
  # shellcheck source=dokploy.sh
  . "$here/dokploy.sh"
else
  echo "walk.sh: no platform $platform (coolify or dokploy)" >&2
  exit 2
fi

in_c() { docker exec "$container" "$@"; }
api() { in_c env WALK_BASE=http://127.0.0.1:7340/v2 node /walk/api.mjs "$@"; }
# A variable of the server's container, as the platform set it: read for its shape, never printed.
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n "s/^$1=//p"; }
container='' removed=''

finish() {
  code=$?
  trap - EXIT INT TERM
  if [ "$code" != 0 ]; then
    echo "--- the platform's log and the server's log tail, on failure:" >&2
    logs >&2 || true
    [ -z "$container" ] || docker logs --tail 60 "$container" >&2 || true
  fi
  report "$code"
  [ -n "$removed" ] || remove >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM
# A value the platform's API gave: there, and not JSON's null.
made() { [ -n "$1" ] && [ "$1" != null ]; }

install
pass "installed" "$platform $version, its API answering with a key the walk made"

node "$here/overlay.mjs" "$template" "$walk" >"$work/compose.yml"
deploy "$work/compose.yml"
tries=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null)" = healthy ]; do
  tries=$((tries + 1))
  [ "$tries" -le 100 ] || fail "deployed" "$container not healthy within 300 s: $(docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$container" 2>&1)"
  sleep 3
done
pass "deployed" "$container healthy, image $(docker inspect -f '{{.Config.Image}}' "$container")"

token=$(env_of AGENTRUN_TOKEN | tr -d '\n' | wc -c)
seal=$(env_of AGENTRUN_SEAL_KEY | base64 -d 2>/dev/null | wc -c)
if [ "$token" -lt 64 ] || [ "$seal" != 32 ]; then
  fail "keys made" "AGENTRUN_TOKEN $token characters (not 64 or more), AGENTRUN_SEAL_KEY $seal bytes (not 32)"
fi
pass "keys made" "by $platform: AGENTRUN_TOKEN $token characters, AGENTRUN_SEAL_KEY base64 of $seal bytes"

url=$(env_of AGENTRUN_PUBLIC_URL)
[ "$url" = "http://$host" ] || fail "public URL" "AGENTRUN_PUBLIC_URL is '$url', not the service's domain http://$host"
# The platform's proxy on this machine's port 80, at the domain's name (no DNS needed).
code=$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$host:80:127.0.0.1" "$url/v2/health" || true)
[ "$code" = 200 ] || fail "public URL" "GET $url/v2/health through $platform's proxy: HTTP $code"
pass "public URL" "AGENTRUN_PUBLIC_URL $url, $platform's domain; GET /v2/health there through its proxy: 200"

data=$(in_c stat -c '%U:%G %a' /data)
[ "$data" = "node:node 711" ] || fail "data directory" "/data is $data, not node:node 711 (the image's: a run crosses it without listing it)"
pass "data directory" "/data on the volume is $data"

isolation=$(get "$(api isolation)" run_isolation)
[ "$isolation" = uid ] || fail "run user" "run_isolation is $isolation, not uid: each run is not a user of its own"
pass "run user" "run_isolation $isolation: each run's process is a user of its own"

agent=$(get "$(api agent)" agent)
run=$(get "$(api start "$agent" 3 0)" run)
ended_once "first run" "$(api end "$run")" 3

remove
removed=1
tries=0
until [ -z "$(left)" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "removed" "still there 180 s after the delete: $(left | tr '\n' ' ')"
  sleep 3
done
pass "removed" "deleted through $platform's API with its volume: no container or volume of it left"
