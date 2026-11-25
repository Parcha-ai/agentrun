# A harness recipe: Google Antigravity

[`antigravity.json`](../../packages/run-adapters-acp/recipes/bundled/antigravity.json) is a recipe
([HARNESS.md](../../HARNESS.md#a-recipe)) for Google's agy CLI 1.5.14 as an ACP agent (`agy acp`), the way
[T3 Code](https://github.com/pingdotgg/t3code) runs it. No AgentRun code is Antigravity's own: the recipe is all of it.
AgentRun ships it with the ACP adapter (`@parcha/agentrun-harness-acp`), so every command takes its name, `antigravity`,
where it takes a recipe file. Each one says which recipe it resolved. A file named `antigravity` in the directory you
run it from is never passed over: the command is refused, saying both, and `./antigravity` names your file.

What each part does:

- `release`: Google's own release of the CLI, one `.tar.gz` per platform holding the single binary `./antigravity`,
  each pinned by the sha512 its manifest lists. No digest of the unpacked binary is published, so the first install
  records the binary's and the whole tree's (rule 2).
- `args` and `env`: `acp --disable-telemetry`, with the CLI's self-update off (`AGY_CLI_DISABLE_AUTO_UPDATE`) and its
  sign-in kept in files (`AGY_ACP_FORCE_FILE_STORAGE`), as T3 Code sets them.
- `keys` and `keyMethod`: a Gemini API key from Google AI Studio, saved for this harness alone as
  `ANTIGRAVITY_GEMINI_API_KEY`, handed to the agent as `GEMINI_API_KEY`, and the adapter tells it ACP `authenticate`
  with `gemini-api-key` before any session opens. `harness-check`, scheduled runs and shared servers run on it. The
  server's own `GEMINI_API_KEY`, if it holds one, never reaches the agent.
- `signIn`: the agent's own `agy acp --login`, with `--gemini-dir` naming the folder it keeps that sign-in in, and
  `terms` Google's Antigravity terms. On your own machine alone, you sign in once on your own install, after a warning
  that Google's terms may not cover use through AgentRun; AgentRun never reads, refreshes or sends the token
  ([Sign-in](../../HARNESS.md#sign-in), [Vendor terms](../../HARNESS.md#vendor-terms)).
- `model`: plan billing. Google bills the person's plan (or the key's project); AgentRun sees none of those requests,
  so the adapter stops a run at 20 turns or 40 tool calls. `hosts` names the Google hosts the binary refers to.
- `announces`: where agy's `tool_call` names the tool it calls. Its `name` field holds `mcp_agentrun_<tool>` (`prefix`),
  and the arguments it reports carry its own `toolSummary` beside the call's, which the MCP call never has (`extras`), so
  the adapter leaves it out before matching the two. agy's title (`Run mcp_agentrun_<tool>`) names nothing.
- `state`: `.gemini/antigravity-cli/conversations`, where agy 1.5.14 keeps each conversation (a SQLite file), so
  another runner's agent loads it after a kill.
- `declares`: the agent's `initialize` advertises `loadSession` and no MCP over HTTP, so AgentRun's tools reach it over
  stdio.
- `quirks.permissionTie`: `"title"`. agy asks permission for every MCP call, AgentRun's included, and the adapter answers
  allow once a request whose title names a tool of ours, for a call `announces` named as that same tool. The host's gate
  is asked at the MCP call itself.

## Use it

```sh
agentrun harness install antigravity
ANTIGRAVITY_GEMINI_API_KEY=... agentrun harness-check --recipe antigravity
agentrun-serve --harness-recipe antigravity
```

The install downloads about 100 MB, which unpacks to one binary of about 270 MB (linux-x86_64). `harness-check` runs on
`ANTIGRAVITY_GEMINI_API_KEY` and never on a sign-in. It takes no `--model` for a plan-billed agent: it runs on the
agent's default model, or on `model.id` when the recipe names one. The server's runs of it go on the key saved for it
alone in Settings → Harness keys (`agentrun harness keys` prints the link,
[Its keys](../../HARNESS.md#its-keys)).

On your own machine alone, your own runs can go on your own Google sign-in instead:

```sh
agentrun harness sign-in --recipe antigravity
agentrun-serve --harness-recipe antigravity --harness-sign-in
```

The sign-in warns once that Google's terms may not cover use through AgentRun, then prints a Google address: open it in
any browser, sign in, and paste the code back into the terminal. `--harness-sign-in` refuses to start a server that is
not yours alone on your machine ([Run it](../../HARNESS.md#run-it)). An agent with `"harness": "antigravity"` then runs
on it. Never share the sign-in or the server's runs on it.

## Checked

The recipe passes `harness-check` on a Gemini API key (agy 1.5.14, linux-x86_64): a call of AgentRun's tool over MCP,
a denied call asked of the host's gate, a resume after a kill (`session/load`) and another runner picking the session
up. Plan billing hides the agent's model requests, so two things stay **unverified**: whether its own tools stay out of
the way of AgentRun's, and what it sends to `hosts`.

[HARNESS-SCORECARD.md](../../HARNESS-SCORECARD.md) carries its row.
