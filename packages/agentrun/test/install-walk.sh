#!/usr/bin/env bash
# The installer's walk on a fresh machine, with no Node.js on PATH (CI: .github/workflows/install-walk.yml).
#   install-walk.sh service [installer options]    launchd (macOS) or a systemd user session (Linux): install.sh starts
#       the service; its health through a stop and start, a restart by the service manager, `service restart`, a crash
#       (SIGKILL), running the installer again, and `service uninstall`.
#   install-walk.sh container [installer options]  no service manager: the installer piped to sh, `service install`
#       refused in words; the default start, in the background, returns and AgentRun answers after it; an older launcher
#       with no `agentrun stop`, then this one again, each replace it; `agentrun stop` stops it. Then --tailscale with no
#       tailscale, and with a fake one first on PATH (fake-tailscale.sh): logged in, where the served name opens the
#       setup that takes the code, not an open server; operator rights refused; Funnel on; and --no-tailscale.
#   install-walk.sh first-run [installer options]  the setup prompt's own lines (docs/SKILL.md), timed from the installer
#       to a finished first run against the bar, 5 minutes: the installer (a service where there is a service manager,
#       else the background), the Local model step on a stand-in for Ollama (walk-model.mjs), `server capabilities`
#       until models.ready, then the release-notes agent and its first run. With --tailscale, a fake tailscale that is
#       logged in (fake-tailscale.sh) first on PATH, and the tailnet address printed.
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

# --tailscale in the background (no service manager), with no tailscale, then a fake one (fake-tailscale.sh) in a fresh
# state folder per case. No tailnet is touched.
tailnet_walk() {
  local name=box.tail1234.example again='curl -fsSL https://agentrun.ai/install | sh -s -- --tailscale' fakes code session
  if ! ls "$HOME"/.agentrun/lib/*/node_modules/@parcha/agentrun/lib/tailscale.mjs > /dev/null 2>&1; then
    echo "skip: the launcher installed has no --tailscale"
    return 0
  fi
  step "--tailscale with no tailscale: AgentRun starts anyway, the steps and the command to run again are said, exit 0"
  if command -v tailscale; then die "tailscale is on PATH"; fi
  piped_install 300 /tmp/ts-missing.log --tailscale "$@"
  grep -q "^Tailscale is not installed here, so AgentRun is on this machine only for now" /tmp/ts-missing.log || die "no word that Tailscale is missing"
  grep -q "1\. Install Tailscale: https://tailscale.com/download/linux" /tmp/ts-missing.log || die "no install link"
  grep -q "2\. Connect this machine to your tailnet: .*tailscale up" /tmp/ts-missing.log || die "no tailscale up step"
  grep -qF "Then run again: $again" /tmp/ts-missing.log || die "no command to run again"
  grep -q "free: up to 6 users, unlimited user devices" /tmp/ts-missing.log || die "no price line"
  grep -q "AgentRun is running at http://127.0.0.1:7340/" /tmp/ts-missing.log || die "not started on 7340"

  fakes=$(mktemp -d)
  cp "$here/test/fake-tailscale.sh" "$fakes/tailscale"
  chmod 755 "$fakes/tailscale"
  export PATH="$fakes:$PATH"
  export FAKE_TAILSCALE_DIR

  step "--tailscale, logged in (a fake tailscale): served at https://$name/ to 127.0.0.1:7340"
  FAKE_TAILSCALE_DIR=$(mktemp -d)
  : > "$FAKE_TAILSCALE_DIR/other"
  piped_install 300 /tmp/ts.log --tailscale "$@"
  grep -q "AgentRun is on your tailnet at https://$name/ (tailscale serve)" /tmp/ts.log || die "no tailnet address printed"
  [ "$(cat "$FAKE_TAILSCALE_DIR/served")" = http://127.0.0.1:7340 ] || die "serve proxies $(cat "$FAKE_TAILSCALE_DIR/served")"
  cat "$FAKE_TAILSCALE_DIR/calls"
  grep -q "funnel" "$FAKE_TAILSCALE_DIR/calls" && die "tailscale funnel was run"
  healthy 10
  [ "$(base)" = http://127.0.0.1:7340/v2 ] || die "the server is at $(base), not 127.0.0.1:7340"

  step "what the served name opens: the console, whose setup takes the code in the log, not an open server"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $name" -H 'accept: text/html' http://127.0.0.1:7340/)
  [ "$code" = 200 ] || die "the page at Host $name answered $code"
  session=$(curl -fsS -H "Host: $name" "$(base)/auth/session")
  echo "$session"
  grep -q '"password_set": *false' <<< "$session" || die "a password is already set"
  grep -q '"setup_code": *true' <<< "$session" || die "setup takes no code: an open server"
  # As the page at the served name sends it through tailscale serve (which adds X-Forwarded-Proto: https), with no code.
  code=$(curl -s -o /tmp/ts-setup.json -w '%{http_code}' -X POST -H "Host: $name" -H "Origin: https://$name" -H 'X-Forwarded-Proto: https' -H 'content-type: application/json' --data '{"password":"not-a-secret"}' "$(base)/setup")
  cat /tmp/ts-setup.json
  echo
  [ "$code" = 403 ] && grep -q "takes the setup code in its log" /tmp/ts-setup.json || die "a setup with no code answered $code"
  grep -q "Set up this server: https://$name/setup#code=" "$log" || die "the log has no setup link at https://$name/"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: elsewhere.example' "$(base)/auth/session")
  [ "$code" = 403 ] || die "another Host name answered $code"

  step "--tailscale with operator rights refused: the one sudo line, exit 0"
  FAKE_TAILSCALE_DIR=$(mktemp -d)
  echo denied > "$FAKE_TAILSCALE_DIR/mode"
  piped_install 300 /tmp/ts-denied.log --tailscale "$@"
  grep -qx '  sudo tailscale set --operator=\$USER' /tmp/ts-denied.log || die "no operator line"
  [ ! -s "$FAKE_TAILSCALE_DIR/served" ] || die "something was served"
  healthy 10

  step "--tailscale with Funnel on at that address: refused by name, nothing changed, AgentRun still running"
  FAKE_TAILSCALE_DIR=$(mktemp -d)
  echo http://127.0.0.1:7340 > "$FAKE_TAILSCALE_DIR/served"
  : > "$FAKE_TAILSCALE_DIR/funnel"
  if timeout 300 sh "$here/install.sh" --tailscale "$@" > /tmp/ts-funnel.log 2>&1; then
    cat /tmp/ts-funnel.log
    die "the installer went on with Funnel on"
  fi
  cat /tmp/ts-funnel.log
  grep -q "Tailscale Funnel is on for https://$name/" /tmp/ts-funnel.log || die "the refusal does not name Funnel"
  grep -q "^serve --bg" "$FAKE_TAILSCALE_DIR/calls" && die "serve ran with Funnel on"
  healthy 10

  step "--no-tailscale: only the entry it added goes"
  FAKE_TAILSCALE_DIR=$(mktemp -d)
  : > "$FAKE_TAILSCALE_DIR/other"
  piped_install 300 /tmp/ts-on.log --tailscale "$@"
  piped_install 300 /tmp/ts-off.log --no-tailscale "$@"
  grep -q "Removed AgentRun from your tailnet" /tmp/ts-off.log || die "the entry was not removed"
  [ ! -s "$FAKE_TAILSCALE_DIR/served" ] || die "still served: $(cat "$FAKE_TAILSCALE_DIR/served")"
  [ -f "$FAKE_TAILSCALE_DIR/other" ] || die "the other entry went"
  grep -q "reset" "$FAKE_TAILSCALE_DIR/calls" && die "tailscale serve reset was run"
  [ ! -e "$HOME/.agentrun/tailscale.json" ] || die "the record of the entry is still there"
  "$agentrun" stop
  down 30
}

# The bar (BRIEF-1117): from pasting the setup prompt to a finished first run in under 5 minutes. A person's agent also
# reads and asks between these lines; the walk times what AgentRun does.
bar=300
# docs/SKILL.md's line that starts with $1, or the walk fails: a prompt that no longer says it fails here first.
skill_line() {
  local line
  line=$(grep -m 1 -F -- "$1" "$here/../../docs/SKILL.md") || die "docs/SKILL.md has no line starting $1"
  printf '%s' "$line"
}
first_run_walk() {
  local t0 t_install t_model t_ready t_create t_run total local_model create start ready out nodebin served='' model_log
  local_model=$(skill_line '~/.agentrun/bin/agentrun service install --env AGENT_MODEL_BASE_URL=http://localhost:11434/v1 ')
  local_model=${local_model//<tag>/walk-model}
  grep -qF 'curl -fsSL https://agentrun.ai/install | AGENT_MODEL_BASE_URL=http://localhost:11434/v1' "$here/../../docs/SKILL.md" ||
    die "docs/SKILL.md no longer puts the local model in front of sh for a background start"
  create=$(skill_line "~/.agentrun/bin/agentrun agents create --body '{\"definition\":{\"id\":\"release-notes\"")
  start=$(skill_line '~/.agentrun/bin/agentrun runs start release-notes --wait ')
  if [[ " $* " == *" --tailscale "* ]]; then
    served=box.tail1234.example
    out=$(mktemp -d)
    cp "$here/test/fake-tailscale.sh" "$out/tailscale"
    chmod 755 "$out/tailscale"
    export PATH="$out:$PATH" FAKE_TAILSCALE_DIR
    FAKE_TAILSCALE_DIR=$(mktemp -d)
  fi

  t0=$SECONDS
  step "1. the installer$([ -n "$served" ] && echo ", --tailscale")"
  piped_install "$bar" /tmp/first-install.log "$@"
  healthy 30
  t_install=$((SECONDS - t0))
  if [ -n "$served" ]; then
    grep -q "AgentRun is on your tailnet at https://$served/ (tailscale serve)" /tmp/first-install.log || die "no tailnet address printed"
    grep -q funnel "$FAKE_TAILSCALE_DIR/calls" && die "tailscale funnel was run"
  fi

  step "2. a local model on localhost:11434 (walk-model.mjs, the stand-in for Ollama)"
  nodebin=$(echo "$HOME"/.agentrun/node/*/bin/node)
  model_log=$(mktemp)
  "$nodebin" "$here/test/walk-model.mjs" "$model_log" 11434 > /tmp/walk-model.out 2>&1 &
  for _ in $(seq 1 50); do grep -q 'walk model on' /tmp/walk-model.out && break; sleep 0.1; done
  grep -q 'walk model on' /tmp/walk-model.out || die "the walk model did not start: $(cat /tmp/walk-model.out)"
  if grep -q "so it runs in the background" /tmp/first-install.log; then
    step "   Local model, in the background: agentrun stop, then the installer with the four in front of sh"
    "$agentrun" stop
    down 30
    AGENT_MODEL_BASE_URL=http://localhost:11434/v1 AGENT_MODEL_GATEWAY_IDS=bare AGENT_MODEL=walk-model AGENT_MODEL_PRICE=0,0,0 \
      piped_install "$bar" /tmp/first-model.log "$@"
  else
    step "   Local model, on the service: $local_model"
    bash -c "$local_model"
  fi
  healthy 30
  t_model=$((SECONDS - t0))

  step "3. server capabilities until models.ready"
  ready=
  for _ in $(seq 1 60); do
    out=$("$agentrun" server capabilities 2> /dev/null) || out=
    if [ -n "$out" ] && "$nodebin" -e 'process.exit(JSON.parse(process.argv[1]).models?.ready === true ? 0 : 1)' "$out"; then ready=1; break; fi
    sleep 1
  done
  [ -n "$ready" ] || die "models.ready is not true: $out"
  t_ready=$((SECONDS - t0))

  step "4. $create"
  bash -c "$create"
  t_create=$((SECONDS - t0))

  step "5. $start"
  out=$(bash -c "$start") || die "runs start failed: $out"
  echo "$out"
  t_run=$((SECONDS - t0))
  "$nodebin" -e '
    const run = JSON.parse(process.argv[1]);
    const fail = (why) => { console.error(`FAIL: ${why}`); process.exit(1); };
    if (run.status !== "completed") fail(`the first run is ${run.status}: ${JSON.stringify(run.error ?? null)}`);
    if (!/Added/.test(run.result?.final_answer ?? "")) fail(`the answer did not come from the local model: ${run.result?.final_answer}`);
    if (typeof run.cost?.usd !== "number") fail("no cost.usd");
    if (!/^https?:\/\//.test(run.console_url ?? "")) fail(`no console_url: ${run.console_url}`);
  ' "$out" || die "the first run's receipt is not what the prompt hands over"
  grep -qE '^POST .*/(responses|chat/completions)$' "$model_log" || die "the run never reached the local model: $(cat "$model_log")"

  total=$t_run
  out="paste to first run: ${total}s (bar ${bar}s): installer ${t_install}s, local model $((t_model - t_install))s, models.ready $((t_ready - t_model))s, agent $((t_create - t_ready))s, run $((t_run - t_create))s; \$0 (a local model)"
  step "$out"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "- $(uname -sm)$([ -n "$served" ] && echo ' --tailscale'): $out" >> "$GITHUB_STEP_SUMMARY"
  ((total < bar)) || die "$total s is over the bar, $bar s"
}

step "no Node.js on PATH ($PATH)"
if command -v node; then die "node is on PATH"; fi
uname -a

if [ "$mode" = first-run ]; then
  first_run_walk "$@"
  exit 0
fi

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

  # The store the new server made can be a later schema than $older's server knows, and a server refuses a later store,
  # as it should. So $older starts on a store of its own, the new one set aside, as on a machine that ran $older first;
  # the next step has the installer stop it alone ($older has no agentrun stop) and upgrade that store.
  step "an older version, $older, which has no agentrun stop, on a store of its own"
  "$agentrun" stop
  down 30
  running "$first" && die "agentrun stop left pid $first running"
  mkdir -p /tmp/newer-store
  mv "$HOME"/.agentrun/store.sqlite* /tmp/newer-store/
  piped_install 300 /tmp/older.log --version "$older"
  healthy 10
  second=$(cat "$pidfile")
  [ "$second" != "$first" ] || die "the pid file still names $first"
  grep -qF "/lib/$older/" "$agentrun" || die "agentrun does not run $older: $(tail -n 1 "$agentrun")"

  step "the installer again: stops the AgentRun $older runs itself, and starts the new install on $older's store"
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

  tailnet_walk "$@"
  echo "walk: container ok"
  exit 0
fi

[ "$mode" = service ] || die "mode is service, container or first-run, not $mode"
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
