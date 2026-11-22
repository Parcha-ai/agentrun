#!/bin/sh
# A run of the image holds its own model's key and nothing else, and reaches none of what its server keeps.
#
# A container of <image> is started with every secret the launcher names set to a canary (the seal key a base64 key of 32
# bytes, AGENTRUN_TOKENS an id and a 32-character secret), its server on the faux model of image-custody-faux.mjs (this
# checkout's, copied in readable to every uid). image-custody-check.mjs then makes one run that reports, from inside the
# process its loop runs in, what that process holds and reaches, and one that holds its turn while every process in the
# container is read. The container is given a group (CUSTODY_SOCKET_GID, 4242 by default) as compose gives the server's
# user the Docker socket's. It fails, one line for each, when:
#   - the capabilities do not say run_isolation "uid";
#   - the server's user is in more than 4 groups, or in any slot's group;
#   - the run's process holds any secret but its model's (OpenAI's: the agent is on an OpenAI model), as its own secrets
#     module answers secret(name), or has one in its environment;
#   - the run's process, or a program it starts, runs as the uid that owns the data directory (the server's) or one
#     outside the helper's range, holds a group but its slot's, a capability in any set, or no no_new_privs; lists that
#     directory or reads a file of it (seal/seal.key, the store), or opens the memory of a process of that uid;
#   - of two live runs, one (or a program it starts) shares the other's uid, lists or reads the other's folder, reads its
#     process's environment or descriptors, opens its memory, or connects to a socket of the group the container gives;
#   - a slot's uid lists or reads any entry of the data directory (its harnesses aside, which runs execute);
#   - a cancelled run leaves a process (one in a session of its own included) or a file in /tmp, or the next run on its
#     slot reaches its folder;
#   - a run started with an upload (file_ids) does not read it in its work folder, or a run's next message cannot write
#     beside the folders the server's user left deep in its work folder;
#   - any process has a canary in its environment, its command line or a pipe it holds; one but PID 1 (tini) holds the
#     launcher's pipe; PID 1 is not tini.
# Every container, and the network and Postgres of --two, is removed by its name at the end.
#
#   image-custody.sh [--two] [--seal-file] <image> [docker run arguments...]
#
# One process (the default): the image's server with its runner beside it in the server's process, on the SQLite store
# in /data, AGENTRUN_STORE_URL unset.
# --two: the server and its runner as two processes, on a Postgres store whose URL is a canary (its password), given to
# both. An image with docker/start.sh is given `server-and-runner` (its own two-process command); an older one, the server
# with --no-runner and a runner started beside it in the same container through the image's launcher.
# --seal-file: no seal key is handed, so the server makes its own in /data/seal/seal.key; the check reads that file (as
# the server's uid) for the canary, and the run must not.
# Arguments after the image go to `docker run`: a reviewer can bind-mount a changed launcher read-only over the image's.
# CUSTODY_NAME names the container (and prefixes the others); CUSTODY_DOCKER_TIMEOUT bounds each docker call (seconds);
# CUSTODY_POSTGRES is the Postgres image of --two.
set -eu
two= seal_file=
while :; do
  case ${1-} in
    --two) two=1; shift ;;
    --seal-file) seal_file=1; shift ;;
    *) break ;;
  esac
done
image=${1:?usage: image-custody.sh [--two] [--seal-file] <image> [docker run arguments...]}
shift
here=$(cd "$(dirname "$0")" && pwd)
name=${CUSTODY_NAME:-agentrun-image-custody-$$}
limit=${CUSTODY_DOCKER_TIMEOUT:-300}
postgres=${CUSTODY_POSTGRES:-postgres:17-alpine}
socket_gid=${CUSTODY_SOCKET_GID:-4242}
dk() { timeout "$limit" docker "$@"; }
say() { printf 'image custody: %s\n' "$*" >&2; }
root=/opt/agentrun/packages/serve
launcher=$root/launcher/agentrun-serve
faux=/tmp/image-custody-faux.mjs
cleanup() {
  dk rm -f -v "$name" >/dev/null 2>&1 || true
  if [ -n "$two" ]; then
    dk rm -f -v "$name-pg" >/dev/null 2>&1 || true
    dk network rm "$name-net" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM
# Each value its own. The token's is the API's, 32 characters or more.
canary="nak-$$-$(date +%s)"
seal=
[ -n "$seal_file" ] || seal=$(head -c 32 /dev/urandom | base64)
names=$(dk run --rm --entrypoint sh "$image" -c "sed -n \"s/^SECRETS='\\(.*\\)'\$/\\1/p\" $launcher")
[ -n "$names" ] || { say "the launcher in $image names no secrets"; exit 1; }
shape=one
net=
store=
store_kind=sqlite
if [ -n "$two" ]; then
  if dk run --rm --entrypoint sh "$image" -c "test -f $root/docker/start.sh"; then shape=server-and-runner; else shape=runner-beside; fi
  dk network create "$name-net" >/dev/null
  dk run -d --name "$name-pg" --network "$name-net" -e POSTGRES_USER=agentrun -e POSTGRES_DB=agentrun -e "POSTGRES_PASSWORD=$canary-store" "$postgres" >/dev/null
  i=0
  until dk exec "$name-pg" pg_isready -q -h 127.0.0.1 -U agentrun -d agentrun; do # key-gate: loopback-rule the readiness of Postgres itself, inside its container
    i=$((i + 1))
    [ "$i" -lt 120 ] || { say "Postgres never became ready"; exit 1; }
    sleep 1
  done
  net="--network $name-net"
  store_kind=postgres
  store="postgres://agentrun:$canary-store@$name-pg:5432/agentrun"
fi
# Names and canaries have no spaces, so the -e arguments go as one word list.
secrets=
i=0
for n in $names; do
  i=$((i + 1))
  case $n in
    AGENTRUN_TOKEN) value="$canary-$n" ;;
    AGENTRUN_TOKENS) value="custody:$canary-tokens-0123456789abcdef0123456789" ;;
    AGENTRUN_SEAL_KEY) [ -n "$seal" ] || continue; value=$seal ;;
    AGENTRUN_STORE_URL) [ -n "$store" ] || continue; value=$store ;;
    # A whsec_ secret the server takes (a 32-byte key: 43 base64url characters) that still holds its canary, and the hook's
    # URL it needs beside it (a port nothing answers: no trigger fires here).
    AGENTRUN_LAUNCH_HOOK_SECRET) value="whsec_$(printf '%-43s' "$canary-$i" | tr ' ' k)"; secrets="$secrets -e AGENTRUN_LAUNCH_HOOK_URL=http://127.0.0.1:9/firings" ;;
    *) value="$canary-$i" ;;
  esac
  secrets="$secrets -e $n=$value"
done
case $shape in
  one) set -- "$@" "$image" --data /data --port 7340 --faux "$faux" ;;
  server-and-runner) set -- "$@" "$image" server-and-runner --data /data --port 7340 --faux "$faux" ;;
  runner-beside) set -- "$@" "$image" --data /data --port 7340 --no-runner --faux "$faux" ;;
esac
# shellcheck disable=SC2086
dk create --name "$name" --group-add "$socket_gid" $net $secrets "$@" >/dev/null
# The faux, readable to every uid, in the container's /tmp before it starts.
tar -C "$here" --owner=0 --group=0 --mode=a+r -cf - image-custody-faux.mjs | dk cp - "$name:/tmp"
dk start "$name" >/dev/null
if [ "$shape" = runner-beside ]; then
  i=0
  health=http://127.0.0.1:7340/v2/health # key-gate: loopback-rule the port of the server itself, inside its container
  until dk exec -e "HEALTH=$health" "$name" node -e 'fetch(process.env.HEALTH).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 120 ] || { say "the server never answered /v2/health"; dk logs --tail 40 "$name" >&2 || true; exit 1; }
    sleep 1
  done
  # The runner, through the image's launcher as the server came: its secrets over its own pipe.
  # shellcheck disable=SC2086
  dk exec -d $secrets "$name" "$launcher" -- node "$root/dist/cli.js" runner --data /data --faux "$faux"
fi
say "$image, $shape"
rc=0
dk exec -i -e CANARY="$canary" -e SEAL="$seal" -e TOKEN="$canary-AGENTRUN_TOKEN" -e SOCKET_GID="$socket_gid" -e STORE_KIND="$store_kind" "$name" node --input-type=module - <"$here/image-custody-check.mjs" || rc=$?
if [ "$rc" -ne 0 ]; then
  say "the container's last lines:"
  dk logs --tail 20 "$name" >&2 || true
fi
exit "$rc"
