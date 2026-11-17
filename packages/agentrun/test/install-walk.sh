#!/usr/bin/env bash
# The installer's walk on a fresh machine, with no Node.js on PATH (CI: .github/workflows/install-walk.yml).
#   install-walk.sh service [installer options]    launchd (macOS) or a systemd user session (Linux): install.sh starts
#       the service; its health through a stop and start, a restart by the service manager, `service restart`, a crash
#       (SIGKILL), running the installer again, and `service uninstall`.
#   install-walk.sh container [installer options]  no service manager: the installer piped to sh, `service install`
#       refused in words, and the default start in the terminal.
# Installer options: --package FILE (this checkout's launcher, packed), or none (the published one).
set -euo pipefail
mode=$1
shift
here=$(cd "$(dirname "$0")/.." && pwd)
agentrun=$HOME/.agentrun/bin/agentrun
record=$HOME/.agentrun/.server.json
log=$HOME/.agentrun/logs/agentrun.log

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

step "no Node.js on PATH ($PATH)"
if command -v node; then die "node is on PATH"; fi
uname -a

if [ "$mode" = container ]; then
  step "the installer, piped to sh, --no-start"
  sh -s -- --no-start "$@" < "$here/install.sh"
  step "agentrun --version: $("$agentrun" --version)"
  step "service status: not installed, exit 3"
  expect_exit 3 "$agentrun" service status
  step "service install: refused in words, exit 1"
  out=$("$agentrun" service install 2>&1) && die "service install worked in a container"
  echo "$out"
  grep -q "can't run as a service here" <<< "$out" || die "the refusal does not say why"
  step "the default start: no service manager, so AgentRun runs in this terminal"
  sh "$here/install.sh" "$@" > /tmp/foreground.log 2>&1 &
  started=$!
  healthy 120
  grep -q "runs in this terminal" /tmp/foreground.log || die "the installer did not say it starts in the terminal"
  grep -q "AgentRun is running at" /tmp/foreground.log || die "no address printed"
  cat /tmp/foreground.log
  kill "$started"
  wait "$started" || true
  down 30
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
step "agentrun --version: $("$agentrun" --version)"
step "service status"
"$agentrun" service status
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
