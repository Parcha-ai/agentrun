#!/bin/sh
# The Coolify and Dokploy walk (CI's selfhost-walk job): walk.sh coolify|dokploy installs that platform on this machine
# (a throwaway VM: it takes ports 80 and 443 and, for Dokploy, makes this Docker a swarm), deploys our template through
# the platform's own API so the platform makes the token, the seal key and the domain, and checks what it made: the
# keys, the public address and the platform's proxy reaching the server at it, the data directory, each run's own user,
# the memory the runner budgets (the template's limit), and a first run to completed on the faux model of deploy/walk/faux-steps.mjs (no key, no network; overlay.mjs, with
# the counts off), then that run's page in Chrome, signed in at the domain with the token as the setup code. Then it
# removes the service and its volume through the platform's API and checks nothing is left.
# Needs sudo, docker, curl, jq, Chrome (CHROME_BIN, else playwright's) and node with this checkout's node_modules.
# REPORT=<file> puts the report in that file too; SCREENSHOT=<file> keeps the run's page as a PNG.
# AGENTRUN_IMAGE=<image> walks that image, on this Docker, in place of the template's (the daily walk's, main's):
# pushed to a registry of the walk's own on 127.0.0.1:5000, which the platform pulls it from as it pulls any image.
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
container='' removed='' registry=''

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
  [ -z "$registry" ] || docker rm -f "$registry" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM
# A value the platform's API gave: there, and not JSON's null.
made() { [ -n "$1" ] && [ "$1" != null ]; }

install
pass "installed" "$platform $version, its API answering with a key the walk made"

if [ -n "${AGENTRUN_IMAGE:-}" ]; then
  # After the install: Coolify's restarts Docker.
  registry='walk-registry'
  docker run -d --restart always --name "$registry" -p 127.0.0.1:5000:5000 registry:3.0.0 >/dev/null
  tries=0
  until curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -le 60 ] || fail "image pushed" "the walk's registry on 127.0.0.1:5000 did not answer within 30 s"
    sleep 0.5
  done
  docker tag "$AGENTRUN_IMAGE" 127.0.0.1:5000/agentrun-walk:walk
  docker push -q 127.0.0.1:5000/agentrun-walk:walk >/dev/null || fail "image pushed" "docker push of $AGENTRUN_IMAGE to the walk's registry"
  pass "image pushed" "$AGENTRUN_IMAGE, in place of the template's, as 127.0.0.1:5000/agentrun-walk:walk"
  AGENTRUN_IMAGE=127.0.0.1:5000/agentrun-walk:walk
fi
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

tries=0
until budget=$(docker logs "$container" 2>&1 | grep -E '^Runner [^ ]+ memory: [0-9]+ MiB for runs' | tail -1) && [ -n "$budget" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "runner memory" "no runner memory line within 30 s"
  sleep 0.5
done
case $budget in *" memory: 1920 MiB for runs"*) ;; *) fail "runner memory" "$budget, not 1920 MiB (the template's 2 GB limit less 128 MiB)" ;; esac
pass "runner memory" "$budget"

agent=$(get "$(api agent)" agent)
run=$(get "$(api start "$agent" 3 0)" run)
ended_once "first run" "$(api end "$run")" 3

# A person's first visit at the platform's domain, in Chrome: the token the platform made as the setup code sets a
# password and signs in, and the run's page reads it completed. SCREENSHOT=<file> keeps that page as a PNG.
(umask 077 && env_of AGENTRUN_TOKEN >"$work/code" && openssl rand -hex 16 >"$work/password")
shot=${SCREENSHOT:-$work/console.png}
if ! node "$here/../../apps/console/e2e/setup-code.e2e.mjs" --url "$url" --resolve 127.0.0.1 --setup-code-file "$work/code" \
  --password-file "$work/password" --run "$run" --screenshot "$shot" >"$work/console.log" 2>&1; then
  # Its checks' FAIL lines, else (Chrome never started) the log's last lines: the code and the password are files, in none.
  why=$(grep -E '^(FAIL|--   Chrome)' "$work/console.log" | tr '\n' ' ')
  [ -n "$why" ] || why=$(tail -n 3 "$work/console.log" | tr '\n' ' ')
  fail "console" "$why"
fi
pass "console" "at $url, the token signs in as the setup code and the run's page reads it completed$([ -z "${SCREENSHOT:-}" ] || echo "; $(basename "$shot")")"

remove
removed=1
tries=0
until [ -z "$(left)" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "removed" "still there 180 s after the delete: $(left | tr '\n' ' ')"
  sleep 3
done
pass "removed" "deleted through $platform's API with its volume: no container or volume of it left"
