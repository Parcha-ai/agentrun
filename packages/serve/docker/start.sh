#!/bin/sh
# The image's command, run by tini once the launcher has moved the secrets onto its pipe (the Dockerfile's ENTRYPOINT).
#
#   start.sh server-and-runner OPTION...   the server with OPTION... and --no-runner, and one runner beside it as a
#                                          process of its own on the same data directory (the image's default)
#   start.sh [COMMAND] [ARG...]            agentrun-serve with these arguments, one process, as given: server options
#                                          alone are a server with its runner in its own process, `runner --data D` a
#                                          runner, `reset-password --data D` the password's reset
#
# Why two processes: a runner in the server's process shares the server's store handle, and its journal writes queue the
# API's reads behind them. Apart, each has its own.
#
# server-and-runner needs --data D and --port N among the options. The runner takes the server's --data, its --faux, its
# --drain-timeout and its --max-runs (as --loops). With --no-runner among them the server starts alone. The runner never
# sets the store up and refuses one the server has not, so it starts once the server answers GET /v2/health on its
# --port (on loopback when --listen is 0.0.0.0, ::, or not given; else at the --listen address); a server that has not
# answered in 300 s ends the container.
#
# One process ending ends the other: the script then exits non-zero (that process's exit code, or 1 if it was 0). A
# SIGTERM or SIGINT goes to both as SIGTERM, each drains as it does on its own, and the script exits once both have
# ended: 0 when both exited 0, else the server's code, else the runner's. Both write to this script's stdout and stderr.
#
# The secrets: the launcher hands this script one pipe (AGENTRUN_SECRETS_FD, AGENTRUN_SECRETS_LEN bytes). It reads them
# into its own memory, closes the launcher's pipe, and hands each process the same bytes over a pipe of its own, as the
# launcher does: a FIFO opened and its name removed before a byte is written, written by a fork of this shell (its
# builtin printf into base64), so no secret is ever in an environment or a command line. It keeps them for the runner's
# start, as the server keeps them for its life.
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
cli=$here/dist/cli.js
say() { printf 'agentrun-serve: %s\n' "$*" >&2; }

# Any other command: that command alone, the launcher's pipe and its length handed on as they came.
[ "${1-}" = server-and-runner ] || exec node "$cli" "$@"
shift

data= port= listen= faux= loops= drain= alone=
want=
for arg in "$@"; do
  if [ -n "$want" ]; then
    eval "$want=\$arg"
    want=
    continue
  fi
  case $arg in
    --data) want=data ;;
    --data=*) data=${arg#*=} ;;
    --port) want=port ;;
    --port=*) port=${arg#*=} ;;
    --listen) want=listen ;;
    --listen=*) listen=${arg#*=} ;;
    --faux) want=faux ;;
    --faux=*) faux=${arg#*=} ;;
    --max-runs) want=loops ;;
    --max-runs=*) loops=${arg#*=} ;;
    --drain-timeout) want=drain ;;
    --drain-timeout=*) drain=${arg#*=} ;;
    --no-runner) alone=1 ;;
  esac
done
[ -z "$alone" ] || exec node "$cli" "$@"
if [ -z "$data" ]; then
  say "server-and-runner needs --data DIR: the runner opens the server's store there"
  exit 2
fi
case $port in
  '' | 0 | *[!0-9]*)
    say "server-and-runner needs --port N (not 0): the runner starts once the server answers there"
    exit 2
    ;;
esac
own=127.0.0.1 # key-gate: loopback-rule the loopback of the container the server runs in
# Listening on every address (none named, or a wildcard), the server answers on its own loopback.
case $listen in
  '' | 0.0.0.0 | :: | '[::]') host=$own ;;
  *:*) host="[$listen]" ;;
  *) host=$listen ;;
esac
health="http://$host:$port/v2/health"

# The launcher's secrets, into this shell's memory (base64, as a variable holds no NUL), and its pipe closed.
len=
if [ -n "${AGENTRUN_SECRETS_FD-}" ]; then
  fd=$AGENTRUN_SECRETS_FD
  len=${AGENTRUN_SECRETS_LEN:-0}
  case $fd in [0-9]) ;; *) say "AGENTRUN_SECRETS_FD is a descriptor from 0 to 9, not $fd"; exit 2 ;; esac
  case $len in '' | *[!0-9]*) say "AGENTRUN_SECRETS_LEN is a byte count, not $len"; exit 2 ;; esac
  eval "held=\$(head -c \"\$len\" <&$fd | base64)"
  eval "exec $fd<&-"
  got=$(printf '%s' "$held" | base64 -d | wc -c)
  if [ "$got" -ne "$len" ]; then
    say "the launcher's pipe ended after $got of $len bytes"
    exit 1
  fi
fi
unset AGENTRUN_SECRETS_FD AGENTRUN_SECRETS_LEN

# What each process tells this script, one line each on a pipe of its own: `started NAME PID`, `ended NAME CODE`, and
# the health wait's `healthy` or `unhealthy`. Opened read-write, so neither end waits; its name is gone at once.
dir=$(mktemp -d "${TMPDIR:-/tmp}/agentrun-start.XXXXXX")
mkfifo -m 600 "$dir/events"
exec 9<>"$dir/events"
rm -f "$dir/events"
rmdir "$dir"

# Starts "$@" in the background, with the secrets on fd 3 over a pipe of its own when the launcher handed any: $! is it.
hand() {
  if [ -z "$len" ] || [ "$len" -eq 0 ]; then
    "$@" 9>&- &
    return 0
  fi
  pipe=$(mktemp -d "${TMPDIR:-/tmp}/agentrun-start.XXXXXX")
  mkfifo -m 600 "$pipe/secrets"
  exec 4<>"$pipe/secrets"
  exec 5<"$pipe/secrets"
  exec 4>"$pipe/secrets"
  rm -f "$pipe/secrets"
  rmdir "$pipe"
  # The writer: forked twice, so tini reaps it; it holds no read end and none of this script's stdio. Once the process
  # has read every byte it ends; if the process ends first, its next write fails and it ends.
  ( (printf '%s' "$held" | base64 -d >&4) & ) 5<&- 9>&- </dev/null >/dev/null 2>&1
  exec 4>&-
  AGENTRUN_SECRETS_FD=3 AGENTRUN_SECRETS_LEN=$len "$@" 3<&5 5<&- 9>&- &
  exec 5<&-
}

# NAME COMMAND...: starts COMMAND and says its pid, then its exit code once it ends (run in a subshell of its own).
watch() {
  name=$1
  shift
  hand "$@"
  pid=$!
  echo "started $name $pid" >&9
  code=0
  wait "$pid" || code=$?
  echo "ended $name $code" >&9
}

start_runner() {
  set -- runner --data "$data"
  [ -z "$drain" ] || set -- "$@" --drain-timeout "$drain"
  [ -z "$loops" ] || set -- "$@" --loops "$loops"
  [ -z "$faux" ] || set -- "$@" --faux "$faux"
  (watch runner node "$cli" "$@") &
  runner=starting
}

server=starting server_pid= server_code=0
runner=waiting runner_pid= runner_code=0
outcome= stopping= waiter=

# Every process still running gets SIGTERM (a second signal sends it again: the server's stop then ends at once).
stop() {
  stopping=1
  [ -z "$server_pid" ] || [ "$server" != running ] || kill -TERM "$server_pid" 2>/dev/null
  [ -z "$runner_pid" ] || [ "$runner" != running ] || kill -TERM "$runner_pid" 2>/dev/null
  if [ "$runner" = waiting ]; then
    runner=none
    [ -z "$waiter" ] || kill "$waiter" 2>/dev/null
  fi
  return 0
}
trap stop TERM INT

# A process that ended while the other ran: the other stops, and the script exits non-zero.
ended_alone() {
  [ -z "$stopping" ] || return 0
  say "the $1 exited $2, so the container stops"
  outcome=$2
  [ "$outcome" -ne 0 ] || outcome=1
  stop
}

(watch server node "$cli" "$@" --no-runner) &
(
  tries=0
  until node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$health" </dev/null >/dev/null 2>&1 9>&-; do
    tries=$((tries + 1))
    if [ "$tries" -ge 300 ]; then
      echo unhealthy >&9
      exit 0
    fi
    sleep 1 9>&-
  done
  echo healthy >&9
) &
waiter=$!

while [ "$server" != ended ] || { [ "$runner" != ended ] && [ "$runner" != none ]; }; do
  # A signal cuts the read short: its trap has run, and the loop reads again.
  read -r what name value <&9 || continue
  case $what in
    started)
      if [ "$name" = server ]; then server=running server_pid=$value; else runner=running runner_pid=$value; fi
      # A stop asked before this process's pid was known reaches it now.
      [ -z "$stopping" ] || kill -TERM "$value" 2>/dev/null
      ;;
    ended)
      if [ "$name" = server ]; then server=ended server_code=$value; else runner=ended runner_code=$value; fi
      ended_alone "$name" "$value"
      ;;
    healthy)
      [ -n "$stopping" ] || [ "$runner" != waiting ] || start_runner
      ;;
    unhealthy)
      [ -n "$stopping" ] || { say "the server did not answer $health within 300 s, so the container stops"; outcome=1; runner=none; stop; }
      ;;
  esac
done

if [ -z "$outcome" ]; then
  outcome=$server_code
  [ "$outcome" -ne 0 ] || outcome=$runner_code
fi
exit "$outcome"
