# shellcheck shell=sh disable=SC2154 # repo: the walk that sources this sets it
# The setup prompt's first run (docs/SKILL.md) after a walk's own start, sourced by install-walk.sh and npx-walk.sh.
# POSIX sh. Each function returns 1 with the reason in fr_why. Needs $repo, and node as $1 where a function takes it
# (install-walk's machines have none on PATH).

# The prompt's lines, its CLI as $1 (a command line run with sh -c) and its Local model, an Ollama on 127.0.0.1:$2:
# fr_create and fr_start (the release-notes agent and its run), fr_service (the service told where Ollama listens) and
# fr_vars (the same, one VARIABLE=value each, as the prompt puts them in front of a background start's sh).
first_run_lines() {
  fr_skill=$repo/docs/SKILL.md
  # The prompt's lines start with a literal ~/, looked for as written: nothing here expands it.
  # shellcheck disable=SC2088
  fr_create=$(grep -m 1 -F -- "~/.agentrun/bin/agentrun agents create --body '{\"definition\":{\"id\":\"release-notes\"" "$fr_skill")
  # shellcheck disable=SC2088
  fr_start=$(grep -m 1 -F -- '~/.agentrun/bin/agentrun runs start release-notes --wait ' "$fr_skill")
  # shellcheck disable=SC2088
  fr_service=$(grep -m 1 -F -- '~/.agentrun/bin/agentrun service install --env OLLAMA_HOST=<host:port>' "$fr_skill")
  # The background start's variables, as the prompt writes them (its line wraps).
  # shellcheck disable=SC2016 # backticks of the prompt's Markdown, matched as written
  fr_vars=$(tr '\n' ' ' <"$fr_skill" | grep -o -m 1 'curl -fsSL https://agentrun.ai/install | [A-Z_]*=[^`]* sh`' |
    sed 's#^curl -fsSL https://agentrun.ai/install | ##; s# sh`$##')
  if [ -z "$fr_create" ] || [ -z "$fr_start" ] || [ -z "$fr_service" ] || [ -z "$fr_vars" ]; then
    fr_why="docs/SKILL.md no longer has the release-notes agent, its run, or the Local model's service and background lines"
    return 1
  fi
  for fr_pair in $fr_vars; do
    printf '%s' "$fr_pair" | grep -qE '^[A-Z_]+=[^=]*$' || { fr_why="the background start's line has $fr_pair, not a VARIABLE=value" && return 1; }
  done
  fr_at="s|~/.agentrun/bin/agentrun|$1|g; s|<host:port>|127.0.0.1:$2|g"
  fr_create=$(printf '%s' "$fr_create" | sed "$fr_at")
  fr_start=$(printf '%s' "$fr_start" | sed "$fr_at")
  fr_service=$(printf '%s' "$fr_service" | sed "$fr_at")
  fr_vars=$(printf '%s' "$fr_vars" | sed "$fr_at")
}

# The fake Ollama (walk-model.mjs: no key, no network, no download) with node $1 on port $3, its log and output in
# folder $2: fr_model (its pid) and fr_model_log.
first_run_model() {
  fr_model_log=$2/model.log
  "$1" "$repo/packages/agentrun/test/walk-model.mjs" "$fr_model_log" "$3" >"$2/model.out" 2>&1 &
  # shellcheck disable=SC2034 # the walk stops it
  fr_model=$!
  fr_tries=0
  until grep -q 'walk model on' "$2/model.out"; do
    fr_tries=$((fr_tries + 1))
    [ "$fr_tries" -le 50 ] || { fr_why="the fake Ollama did not start: $(cat "$2/model.out")" && return 1; }
    sleep 0.1
  done
}

# `server capabilities` with the CLI $2 until models.ready, up to 60 s; node $1 reads it.
first_run_ready() {
  fr_tries=0
  until fr_out=$(sh -c "$2 server capabilities" 2>/dev/null) && "$1" -e 'process.exit(JSON.parse(process.argv[1]).models?.ready === true ? 0 : 1)' "$fr_out" 2>/dev/null; do
    fr_tries=$((fr_tries + 1))
    [ "$fr_tries" -le 60 ] || { fr_why="server capabilities: models.ready is not true: $fr_out" && return 1; }
    sleep 1
  done
}

# The release-notes agent made with the prompt's line.
first_run_agent() {
  fr_out=$(sh -c "$fr_create" 2>&1) || { fr_why="agents create: $(printf '%s' "$fr_out" | tail -n 1)" && return 1; }
}

# Its first run with the prompt's line, and the receipt the prompt hands over (node $1 reads it): completed, the answer
# from the local model, cost.usd and console_url; and the model's log shows the run reached Ollama's own chat, which
# only a model AgentRun listed from it is sent to. The receipt: fr_receipt.
first_run_run() {
  fr_receipt=$(sh -c "$fr_start" 2>&1) || { fr_why="runs start: $(printf '%s' "$fr_receipt" | tail -n 1)" && return 1; }
  # shellcheck disable=SC2016 # JavaScript, its template strings its own
  fr_why=$("$1" -e '
    const run = JSON.parse(process.argv[1]);
    if (run.status !== "completed") console.log(`the first run is ${run.status}: ${JSON.stringify(run.error ?? null)}`);
    else if (!/Added/.test(run.result?.final_answer ?? "")) console.log(`the answer did not come from the local model: ${run.result?.final_answer}`);
    else if (typeof run.cost?.usd !== "number") console.log("no cost.usd on the receipt");
    else if (!/^https?:\/\//.test(run.console_url ?? "")) console.log(`no console_url on the receipt: ${run.console_url}`);
  ' "$fr_receipt" 2>&1) || fr_why="the receipt is not JSON: $fr_why"
  [ -z "$fr_why" ] || return 1
  grep -qE '^POST /api/chat$' "$fr_model_log" || { fr_why="the run never reached the local model: $(cat "$fr_model_log")" && return 1; }
}
