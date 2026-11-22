# A harness recipe: Google Antigravity

`antigravity.json` is a recipe ([HARNESS.md](../../HARNESS.md#a-recipe)) for Google's agy CLI 1.5.14 as an ACP agent
(`agy acp`), the way [T3 Code](https://github.com/pingdotgg/t3code) runs it. No AgentRun code is Antigravity's own:
the recipe is all of it.

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
- `declares`: the agent's `initialize` advertises `loadSession` and MCP over HTTP.

## Use it

```sh
agentrun harness install --recipe examples/harness-recipe/antigravity.json
ANTIGRAVITY_GEMINI_API_KEY=... agentrun harness-check --recipe examples/harness-recipe/antigravity.json
```

The install downloads about 100 MB. `harness-check` runs on `ANTIGRAVITY_GEMINI_API_KEY` and never on a sign-in. It
takes no `--model` for a plan-billed agent: it runs on the agent's default model, or on `model.id` when the recipe names
one.

A server saves no harness's keys yet, so a server runs this recipe only on your own machine, on your own Google
sign-in, for the runs you start yourself:

```sh
agentrun harness sign-in --recipe examples/harness-recipe/antigravity.json
agentrun-serve --harness-recipe examples/harness-recipe/antigravity.json --harness-sign-in
```

The sign-in warns once that Google's terms may not cover use through AgentRun, then prints a Google address: open it in
any browser, sign in, and paste the code back into the terminal. `--harness-sign-in` refuses to start a server that is
not yours alone on your machine ([Run it](../../HARNESS.md#run-it)). An agent with `"harness": "antigravity"` then runs
on it. Never share the sign-in or the server's runs on it. A scheduled or triggered run is refused until a harness's
own keys can be saved on a server.

## Not yet checked

The recipe loads under the five rules (`packages/serve/test/harness-recipe.test.mjs`), but it has not passed
`harness-check` on a real sign-in or key yet. Until it does, these are read from the agent's binary, not seen in a run:

- `declares` (`loadSession`, MCP over HTTP);
- `hosts`. Check once with no `hosts`, and the report's `side_requests.beyondLoopbackRefused` lists every host it
  reached for;
- whether its own tools stay out of the way of AgentRun's, and how it resumes after a kill.

[HARNESS-SCORECARD.md](../../HARNESS-SCORECARD.md) carries its row.
