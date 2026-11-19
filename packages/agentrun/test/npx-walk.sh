#!/bin/sh
# The npx walk (ways-in-daily.yml's npx row): the start command the README tells people to type, word for word (so the
# package and dist-tag it names), on a machine with Node.js and a HOME of its own: what a person gets from npm today,
# the launcher and the server it installs, with npm resolving their dependencies afresh. The command keeps the server in
# the foreground, in a person's terminal; the walk leaves it running so (in the background, its output in a file) while
# the setup prompt's release-notes agent (docs/SKILL.md) is made and run with the README's CLI, the same command in a
# second terminal, on its Local model (walk-model.mjs, the stand-in for Ollama: no key, no network); the receipt
# is checked, and the server stopped as a person stops it there, with Ctrl-C (`agentrun stop` stops only a server started
# in the background). REPORT=<file> puts the report in that file too; WALK_MODEL_PORT moves the
# stand-in off 11434, the prompt's port, where a machine has Ollama on it. Needs node, npm, curl and setsid.
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
model='' group=''

finish() {
  code=$?
  trap - EXIT INT TERM
  if [ "$code" != 0 ] && [ -f "$work/start.log" ]; then
    echo "--- the server's output, its tail, on failure:" >&2
    tail -n 40 "$work/start.log" >&2 || true
  fi
  report "$code"
  [ -z "$group" ] || kill -TERM -"$group" 2>/dev/null || true
  [ -z "$model" ] || kill "$model" 2>/dev/null || true
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM

# The README's start, its first line that is the command alone; and the prompt's lines, with its CLI and model in place.
cmd=$(sed -n 's/^ *\(npx @parcha\/agentrun\(@[^ ]*\)\{0,1\}\) *$/\1/p' "$repo/README.md" | head -n 1)
[ -n "$cmd" ] || fail "the README's command" "README.md has no line that is npx @parcha/agentrun alone"
# The prompt's lines start with a literal ~/, which skill looks for as written: nothing here expands it.
# shellcheck disable=SC2088
skill() { grep -m 1 -F -- "$1" "$repo/docs/SKILL.md" | sed "s|~/.agentrun/bin/agentrun|$cmd|"; }
# shellcheck disable=SC2088
create=$(skill "~/.agentrun/bin/agentrun agents create --body '{\"definition\":{\"id\":\"release-notes\"")
# shellcheck disable=SC2088
start=$(skill '~/.agentrun/bin/agentrun runs start release-notes --wait ')
# The Local model's variables, as the prompt puts them in front of a background start.
# shellcheck disable=SC2016 # backticks of the prompt's Markdown, matched as written
vars=$(tr '\n' ' ' <"$repo/docs/SKILL.md" | grep -o -m 1 'curl -fsSL https://agentrun.ai/install | [A-Z_]*=[^`]* sh`' |
  sed "s#^curl -fsSL https://agentrun.ai/install | ##; s# sh\`\$##; s#<tag>#walk-model#g; s#localhost:11434#localhost:$port#g")
if [ -z "$create" ] || [ -z "$start" ] || [ -z "$vars" ]; then
  fail "the README's command" "docs/SKILL.md no longer has the release-notes agent, its run or the Local model's variables"
fi
pass "the README's command" "$cmd (node $(node --version), npm $(npm --version))"

node "$here/test/walk-model.mjs" "$work/model.log" "$port" >"$work/model.out" 2>&1 &
model=$!
tries=0
until grep -q 'walk model on' "$work/model.out"; do
  tries=$((tries + 1))
  [ "$tries" -le 50 ] || fail "started" "the stand-in model did not start: $(cat "$work/model.out")"
  sleep 0.1
done

t0=$(date +%s)
# In a process group of its own, as a terminal starts it, so Ctrl-C reaches it as a terminal sends it: SIGINT to the
# group. (sh starts it with SIGINT ignored, as it starts any background command; npm, the launcher and the server each
# start their own children with it back to the default, and catch it, as in a terminal.)
# shellcheck disable=SC2086 # the prompt's words, one VARIABLE=value each, and the README's command as words
setsid env $vars $cmd </dev/null >"$work/start.log" 2>&1 &
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

tries=0
until out=$($cmd server capabilities 2>/dev/null) && printf '%s' "$out" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.exit(JSON.parse(s).models?.ready === true ? 0 : 1))'; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "models ready" "server capabilities: models.ready is not true: $out"
  sleep 1
done
pass "models ready" "server capabilities: models.ready, on the Local model at localhost:$port"

sh -c "$create" >"$work/create.log" 2>&1 || fail "agent made" "$(tail -1 "$work/create.log")"
pass "agent made" "release-notes, the setup prompt's agent, with $cmd agents create"

receipt=$(sh -c "$start" 2>"$work/run.err") || fail "first run" "runs start: $(tail -1 "$work/run.err")"
# shellcheck disable=SC2016 # JavaScript, its template strings its own
why=$(printf '%s' "$receipt" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const run = JSON.parse(s);
    if (run.status !== "completed") return console.log(`the run is ${run.status}: ${JSON.stringify(run.error ?? null)}`);
    if (!/Added/.test(run.result?.final_answer ?? "")) return console.log(`the answer is not from the local model: ${run.result?.final_answer}`);
    if (typeof run.cost?.usd !== "number") return console.log("no cost.usd");
    if (!/^https?:\/\//.test(run.console_url ?? "")) return console.log(`no console_url: ${run.console_url}`);
  });')
[ -z "$why" ] || fail "first run" "$why"
grep -qE '^POST .*/(responses|chat/completions)$' "$work/model.log" || fail "first run" "the run never reached the local model"
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
