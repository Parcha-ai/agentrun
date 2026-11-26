#!/bin/sh
# The npx walk (ways-in-daily.yml's npx row): the start command the README tells people to type, word for word (so the
# package and dist-tag it names), on a machine with Node.js and a HOME of its own: what a person gets from npm today,
# the launcher and the server it installs, with npm resolving their dependencies afresh. The command keeps the server in
# the foreground, in a person's terminal; the walk leaves it running so (in the background, its output in a file) while
# the setup prompt's release-notes agent (docs/SKILL.md) is made and run with the README's CLI, the same command in a
# second terminal, on its Local model (walk-model.mjs, a fake Ollama: no key, no network, no download); the receipt
# is checked, and the server stopped as a person stops it there, with Ctrl-C (`agentrun stop` stops only a server started
# in the background). REPORT=<file> puts the report in that file too; WALK_MODEL_PORT moves the
# fake off 11434, Ollama's own port, where a machine has Ollama on it. Needs node, npm, curl and setsid.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
rows="$work/rows"
: >"$rows"
. "$repo/deploy/walk/rows.sh"
# npm's cache in that HOME too, empty: a first npx, whatever cache this machine names.
export HOME="$work/home" npm_config_cache="$work/home/.npm" NPM_CONFIG_CACHE="$work/home/.npm" AGENTRUN_TELEMETRY=0
mkdir -p "$HOME"
# Out of this checkout, whose node_modules npx would take the launcher from: from the home folder, as a person's terminal
# opens in it.
cd "$HOME"
record=$HOME/.agentrun/.server.json
port=${WALK_MODEL_PORT:-11434}
fr_model='' group=''

finish() {
  code=$?
  trap - EXIT INT TERM
  if [ "$code" != 0 ] && [ -f "$work/start.log" ]; then
    echo "--- the server's output, its tail, on failure:" >&2
    tail -n 40 "$work/start.log" >&2 || true
  fi
  report "$code"
  [ -z "$group" ] || kill -TERM -"$group" 2>/dev/null || true
  [ -z "$fr_model" ] || kill "$fr_model" 2>/dev/null || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM

# The README's start, its first line that is the command alone; and the prompt's lines (first-run.sh, which
# install-walk.sh takes too), with this command for its CLI and the fake Ollama's port.
cmd=$(sed -n 's/^ *\(npx @parcha\/agentrun\(@[^ ]*\)\{0,1\}\) *$/\1/p' "$repo/README.md" | head -n 1)
[ -n "$cmd" ] || fail "the README's command" "README.md has no line that is npx @parcha/agentrun alone"
# shellcheck source=packages/agentrun/test/first-run.sh
. "$here/test/first-run.sh"
first_run_lines "$cmd" "$port" || fail "the README's command" "$fr_why"
pass "the README's command" "$cmd (node $(node --version), npm $(npm --version))"

first_run_model node "$work" "$port" || fail "started" "$fr_why"

t0=$(date +%s)
# In a process group of its own, as a terminal starts it, so Ctrl-C reaches it as a terminal sends it: SIGINT to the
# group. (sh starts it with SIGINT ignored, as it starts any background command; npm, the launcher and the server each
# start their own children with it back to the default, and catch it, as in a terminal.)
# shellcheck disable=SC2086 # the prompt's words, one VARIABLE=value each, and the README's command as words
setsid env $fr_vars $cmd </dev/null >"$work/start.log" 2>&1 &
group=$!
# The server's record names its address once it listens; then /health. Bounded at 600 s: npm's downloads, not a hang.
base=''
until [ -n "$base" ] && curl -fsS --max-time 3 "$base/health" 2>/dev/null | grep -q '"status": *"ok"'; do
  kill -0 "$group" 2>/dev/null || kill -0 -"$group" 2>/dev/null || fail "started" "$cmd exited: $(tail -1 "$work/start.log")"
  [ $(($(date +%s) - t0)) -le 600 ] || fail "started" "no /health ok within 600 s of $cmd: $(tail -1 "$work/start.log")"
  sleep 1
  base=$(sed -n 's/.*"base_url": *"\([^"]*\)".*/\1/p' "$record" 2>/dev/null | head -n 1)
done
version=$($cmd --version 2>/dev/null | head -n 1)
pass "started" "in $(($(date +%s) - t0)) s from an empty npm cache: launcher $version, the server at $base"

first_run_ready node "$cmd" || fail "models ready" "$fr_why"
pass "models ready" "server capabilities: models.ready, on the Local model, Ollama at 127.0.0.1:$port"

first_run_agent || fail "agent made" "$fr_why"
pass "agent made" "release-notes, the setup prompt's agent, with $cmd agents create"

first_run_run node || fail "first run" "$fr_why"
pass "first run" "completed on the local model in $(($(date +%s) - t0)) s from the start: release notes, cost.usd and console_url on the receipt"

kill -INT -"$group" || fail "stopped" "Ctrl-C: no process group $group to send it to"
tries=0
while kill -0 -"$group" 2>/dev/null || curl -fsS --max-time 2 "$base/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -le 30 ] || fail "stopped" "30 s after Ctrl-C, $cmd is still running or $base still answers"
  sleep 1
done
group=''
pass "stopped" "Ctrl-C: $cmd and everything it started exited, and $base no longer answers"
