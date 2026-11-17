#!/usr/bin/env bash
# The installer's walk on a fresh machine, with no Node.js on PATH (CI: .github/workflows/install-walk.yml).
#   install-walk.sh service [installer options]    launchd (macOS) or a systemd user session (Linux): install.sh starts
#       the service; its health through a stop and start, a restart by the service manager, `service restart`, a crash
#       (SIGKILL), running the installer again, and `service uninstall`.
#   install-walk.sh container [installer options]  no service manager: the installer piped to sh, `service install`
#       refused in words; the default start, in the background, returns and AgentRun answers after it; an older launcher
#       with no `agentrun stop`, then this one again, each replace it; `agentrun stop` stops it.
# Installer options: --package FILE (this checkout's launcher, packed), or none (the published one). NODE_PIN=1 gives the
# installer the launcher's Node floor as --node-version; without it the installer picks the newest on the floor's line.
set -euo pipefail
mode=$1
shift
here=$(cd "$(dirname "$0")/.." && pwd)
agentrun=$HOME/.agentrun/bin/agentrun
record=$HOME/.agentrun/.server.json
log=$HOME/.agentrun/logs/agentrun.log
pidfile=$HOME/.agentrun/agentrun.pid
floor=$(sed -n 's/^ *"node": *">=\([0-9][0-9.]*\)".*/\1/p' "$here/package.json")
# A published launcher from before `agentrun stop`, for the downgrade in the container walk.
older=0.4.9
if [ "${NODE_PIN:-}" = 1 ]; then set -- "$@" --node-version "$floor"; fi

step() { printf '\n== %s\n' "$*"; }
die() {
  echo "FAIL: $*" >&2
  [ -f "$log" ] && tail -n 40 "$log" >&2
  exit 1
}
base() { sed -n 's/.*"base_url": *"\([^"]*\)".*/\1/p' "$record" 2> /dev/null | head -n 1; }
pid() { sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$record" 2> /dev/null | head -n 1; }
# Waits up to $1 seconds for /health ok from the server the record names, other than pid $2 when given.
healthy() {
  local i out
  for ((i = 1; i <= $1; i++)); do
    if [ -n "$(base)" ] && [ "$(pid)" != "${2:-}" ] && out=$(curl -fsS --max-time 3 "$(base)/health" 2> /dev/null) && grep -q '"status": *"ok"' <<< "$out"; then
      echo "health ok after ${i}s: $(base) pid $(pid) $out"
      return 0
    fi
    sleep 1
  done
  die "no /health ok within $1 s"
}
# Waits up to $1 seconds for the server to stop answering.
down() {
  local i
  for ((i = 1; i <= $1; i++)); do
    curl -fsS --max-time 2 "$(base)/health" > /dev/null 2>&1 || { echo "down after ${i}s"; return 0; }
    sleep 1
  done
  die "still answering after $1 s"
}
expect_exit() {
  local want=$1 got=0
  shift
  "$@" || got=$?
  [ "$got" = "$want" ] || die "$* exited $got, not $want"
}
# The Node.js the installer chose, from its output in $1: the floor when pinned, else the newest on the floor's major line
# it named, and never below the floor.
node_chosen() {
  local dirs got said a b c x y z all
  all=("$HOME"/.agentrun/node/*)
  ((${#all[@]} == 1)) && [ -d "${all[0]}" ] || die "node/ holds ${all[*]##*/}"
  dirs=${all[0]##*/}
  got=$("$HOME/.agentrun/node/$dirs/bin/node" --version)
  [ "$got" = "$dirs" ] || die "node/$dirs runs Node.js $got"
  if [ "${NODE_PIN:-}" = 1 ]; then
    [ "$got" = "v$floor" ] || die "pinned to $floor, installed $got"
  else
    said=$(sed -n 's/^Node\.js \([0-9.]*\), the newest .*/\1/p' "$1")
    [ "v$said" = "$got" ] || die "the installer said Node.js $said, and installed $got"
  fi
  IFS=. read -r a b c <<< "${got#v}"
  IFS=. read -r x y z <<< "$floor"
  ((a == x && (b > y || (b == y && c >= z)))) || die "Node.js $got is not on $floor's major line at or above it"
  echo "Node.js $got (floor $floor, $([ "${NODE_PIN:-}" = 1 ] && echo pinned || echo resolved))"
}
# Whether process $1 runs: in /proc and not a zombie (a container's PID 1 may reap nothing).
running() { [ -r "/proc/$1/stat" ] && ! grep -q ') Z ' "/proc/$1/stat"; }
# The installer as `curl | sh` runs it, with a reader that waits for the end of its output, as an agent's shell does: it
# returns 0 within $1 seconds, or the walk fails. Its output goes to $2.
piped_install() {
  local bound=$1 out=$2
  shift 2
  timeout "$bound" bash -c 'cat "$0" | sh -s -- "$@" 2>&1 | cat' "$here/install.sh" "$@" > "$out" || {
    cat "$out"
    die "the installer did not return 0 within $bound s"
  }
  cat "$out"
}

step "no Node.js on PATH ($PATH)"
if command -v node; then die "node is on PATH"; fi
uname -a

if [ "$mode" = container ]; then
  step "the installer, piped to sh, --no-start"
  piped_install 600 /tmp/install.log --no-start "$@"
  node_chosen /tmp/install.log
  step "agentrun --version: $("$agentrun" --version)"
  step "service status: not installed, exit 3"
  expect_exit 3 "$agentrun" service status
  step "service install: refused in words, exit 1"
  out=$("$agentrun" service install 2>&1) && die "service install worked in a container"
  echo "$out"
  grep -q "can't run as a service here" <<< "$out" || die "the refusal does not say why"
  step "the default start, piped: no service manager, so AgentRun runs in the background, and the installer returns"
  piped_install 300 /tmp/background.log "$@"
  grep -q "so it runs in the background" /tmp/background.log || die "the installer did not say it runs in the background"
  grep -q "AgentRun is running at http" /tmp/background.log || die "no address printed"
  grep -q "until this machine or container stops.* stop stops it" /tmp/background.log || die "it does not say how long it runs, or how to stop it"
  first=$(cat "$pidfile")
  running "$first" || die "the pid file names $first, which does not run"
  step "after the installer returned: /v2/health from a new shell"
  healthy 10
  bash -c "curl -fsS '$(base)/health'"
  echo

  step "an older version, $older, which has no agentrun stop: the installer stops the AgentRun it started itself"
  before=$(pid)
  piped_install 300 /tmp/older.log --version "$older"
  grep -q "Stopping the AgentRun started in the background before (pid $first)" /tmp/older.log || die "the installer did not stop pid $first"
  healthy 10 "$before"
  running "$first" && die "the AgentRun started first (pid $first) still runs beside $older"
  second=$(cat "$pidfile")
  [ "$second" != "$first" ] || die "the pid file still names $first"
  grep -qF "/lib/$older/" "$agentrun" || die "agentrun does not run $older: $(tail -n 1 "$agentrun")"

  step "the installer again: stops the AgentRun $older runs, and starts the new install"
  before=$(pid)
  piped_install 300 /tmp/again.log "$@"
  grep -q "Stopping the AgentRun started in the background before (pid $second)" /tmp/again.log || die "the installer did not stop pid $second"
  healthy 10 "$before"
  running "$second" && die "the AgentRun $older ran (pid $second) still runs beside the new one"
  [ "$(cat "$pidfile")" != "$second" ] || die "the pid file still names $second"

  step "agentrun stop"
  "$agentrun" stop
  down 30
  [ ! -e "$pidfile" ] || die "the pid file is still there"
  step "agentrun stop again: none running, exit 3"
  expect_exit 3 "$agentrun" stop
  echo "walk: container ok"
  exit 0
fi

[ "$mode" = service ] || die "mode is service or container, not $mode"
case $(uname -s) in
  Darwin) target=gui/$(id -u)/ai.agentrun.server ;;
  Linux) target=agentrun.service ;;
esac
manager_pid() {
  if [ "$(uname -s)" = Darwin ]; then launchctl print "$target" | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p'; else systemctl --user show -p MainPID --value "$target"; fi
}

step "the installer, default: installs and starts the service"
sh "$here/install.sh" "$@" | tee /tmp/install.log
grep -q "AgentRun is running at" /tmp/install.log || die "no address printed"
healthy 10
node_chosen /tmp/install.log
step "agentrun --version: $("$agentrun" --version)"
step "service status"
"$agentrun" service status
step "agentrun stop, with a service: none in the background, exit 3, and it names service stop"
code=0
out=$("$agentrun" stop) || code=$?
echo "$out"
[ "$code" = 3 ] || die "agentrun stop exited $code with only a service running, not 3"
grep -q "agentrun service stop stops it" <<< "$out" || die "agentrun stop does not name service stop"
healthy 1
if [ "$(uname -s)" = Darwin ]; then
  launchctl print "$target" | grep -E '^[[:space:]]*(state|pid|program) = '
  plutil -lint "$HOME/Library/LaunchAgents/ai.agentrun.server.plist"
else
  [ "$(systemctl --user is-enabled "$target")" = enabled ] || die "the unit is not enabled, so it would not start at login or boot"
  systemctl --user status "$target" --no-pager | head -n 5
fi

step "a new shell, as after closing the terminal: still running"
bash -c "curl -fsS '$(base)/health'"
echo

step "service stop"
"$agentrun" service stop
down 30
expect_exit 1 "$agentrun" service status
step "service start"
"$agentrun" service start
healthy 10

step "restart by the service manager"
before=$(pid)
if [ "$(uname -s)" = Darwin ]; then launchctl kickstart -k "$target"; else systemctl --user restart "$target"; fi
healthy 120 "$before"

step "service restart"
before=$(pid)
"$agentrun" service restart
healthy 10 "$before"

step "a crash: SIGKILL to the service's process, which the manager starts again"
before=$(pid)
kill -9 "$(manager_pid)"
healthy 120 "$before"

step "two older launchers installed with --no-start while the service runs: the running version stays"
serving=$(ls "$HOME/.agentrun/lib")
sh "$here/install.sh" --no-start --version 0.4.8
sh "$here/install.sh" --no-start --version 0.4.9
[ -d "$HOME/.agentrun/lib/$serving" ] || die "the running server's install ($serving) was removed"
[ ! -e "$HOME/.agentrun/lib/0.4.8" ] || die "0.4.8, which nothing runs, was kept"
healthy 10

step "the installer again (an upgrade in place): restarts the service on the new install"
before=$(pid)
sh "$here/install.sh" "$@" | tee /tmp/again.log
grep -q "AgentRun is running at" /tmp/again.log || die "no address printed"
healthy 10 "$before"
[ "$(ls "$HOME/.agentrun/lib")" = "$serving" ] || die "lib/ keeps $(ls "$HOME/.agentrun/lib" | tr '\n' ' '), not only $serving"

step "logs"
"$agentrun" service logs --lines 5

step "service uninstall"
"$agentrun" service uninstall
down 30
expect_exit 3 "$agentrun" service status
if [ "$(uname -s)" = Darwin ]; then
  [ ! -e "$HOME/Library/LaunchAgents/ai.agentrun.server.plist" ] || die "the plist is still there"
  launchctl print "$target" > /dev/null 2>&1 && die "launchd still has the job"
else
  [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agentrun.service" ] || die "the unit is still there"
fi
[ -d "$HOME/.agentrun" ] || die "the data directory went with the service"
echo "walk: service ok"
