# A harness recipe: Google Antigravity

`antigravity.json` is a recipe ([HARNESS.md](../../HARNESS.md#a-recipe)) for Google Antigravity's ACP agent,
`antigravity-acp` 1.5.2, as the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
lists it. No AgentRun code is Antigravity's own: the recipe is all of it.

What each part does:

- `release`: the registry's `.zip` for each platform, pinned by its sha256, with its `cmd`. The archive holds two
  executables, the ACP server and a sidecar it starts (`localharness_external`). Neither digest of what it unpacks to
  is in the registry, so the first install records the binary's and the whole tree's (rule 2). Linux starts with the
  registry's `--uid=`; macOS with no arguments.
- `keys` and `keyMethod`: a Gemini API key from Google AI Studio, saved for this harness alone as
  `ANTIGRAVITY_GEMINI_API_KEY`, reaches the agent as `GEMINI_API_KEY`, and the adapter tells it ACP `authenticate` with
  `gemini-api-key` before any session opens. The server's own `GEMINI_API_KEY`, if it holds one, never reaches the agent.
- `signIn`: the agent's own `oauth-personal`, a person's Google account, on runs its one owner starts and attends.
  `GEMINI_HOME` points the agent at the folder it keeps that sign-in in. [Vendor terms](../../HARNESS.md#vendor-terms)
  links Google's terms and states AgentRun's own, narrower rule for it.
- `model`: plan billing. Google bills the key's project (or, on a sign-in, the person's plan); AgentRun sees none of
  those requests, so the adapter stops a run at 20 turns or 40 tool calls. `hosts` names the Gemini API.
- `declares`: the agent's `initialize` advertises `loadSession` and MCP over HTTP.

## Use it

```sh
agentrun harness install --recipe examples/harness-recipe/antigravity.json
ANTIGRAVITY_GEMINI_API_KEY=... agentrun harness-check --recipe examples/harness-recipe/antigravity.json
```

The install downloads about 270 MB on Linux. `harness-check` takes no `--model` for a plan-billed agent: it runs on the
agent's default model, or on `model.id` when the recipe names one. It runs on the key alone, whatever sign-in exists. To sign
in with your own Google account, for runs you start and attend:

```sh
agentrun harness sign-in --recipe examples/harness-recipe/antigravity.json
```

The agent prints the address to open in your terminal. On a remote server, forward the port in its `redirect_uri`
first ([Sign-in](../../HARNESS.md#sign-in)).

## Not yet checked

The recipe loads under the five rules (`packages/serve/test/harness-recipe.test.mjs`), but it has not passed
`harness-check` on a real key yet. Until it does, these are read from the agent's binary, not seen in a run:

- `declares` (`loadSession`, MCP over HTTP);
- `hosts`: the Gemini API host its key route names. Check once with no `hosts`, and the report's
  `side_requests.beyondLoopbackRefused` lists every host it reached for;
- whether its own tools stay out of the way of AgentRun's, and how it resumes after a kill.

[HARNESS-SCORECARD.md](../../HARNESS-SCORECARD.md) carries its row.
