# Adding a harness

A harness is the loop that runs an AgentRun agent: it sends the model the conversation and runs the tool calls that
come back. AgentRun ships pi, Claude Code, Codex, OpenCode and Goose. This page shows how to add another one without
changing AgentRun: you write a harness module, a small package that the server's owner installs beside the server.

The module tells serve what the harness is (its facts) and how to start it for one run. serve does the rest the way it
does for its own harnesses: which models the harness is offered, which key rows name it, what its offer says when
something is missing, how its tool calls are gated, and how each model request is booked against the run's cap.

[examples/harness-module](examples/harness-module/README.md) is a whole module. It adds Goose, an ACP agent, under an
id of its own, and this page refers to it throughout.

## The first 30 minutes

Each step ends on a command that tells you whether it is done. Run them from the repository root.

1. Watch a module pass before you write one. This runs the conformance suite on the example's harness, against a
   fake ACP agent, with no binary, no model and no key:
   `npm run test:harness-module-example`
   It is done when the last lines read `ℹ pass 25`, `ℹ fail 0` and `ℹ skipped 6`.
2. Copy `examples/harness-module` to a folder of your own and give it your package name. Change [what you
   write](#what-you-write): the id, the facts, the recipe, the proxy and `missing`.
3. Run `npm test` in your copy until it passes the same way ([prove it](#prove-it)).
4. Install it beside a server and start the server with it ([load it](#load-it)). `GET /v2/capabilities` lists your
   harness in `harnesses` after the built-in ones.
5. Run one agent on it on a real model, then [send it](#send-it).

## What you write

A module exports one function, `entries(builtins, kit)`. It returns your harness's entry under its id. serve loads the
module with `require`, so it has no top-level await. Its types come from `@parcha/agentrun-serve/harness`, which loads
nothing of serve. The server hands the module the `kit` from its own copy of serve, so your harness is built the same
way as the built-in ones on that server.

```js
export const entries = (_builtins, kit) => ({
  "goose-module": kit.acpEntry({ facts, missing, recipe, proxy, beforeStart }),
});
```

### The id

A new id that matches `^[a-z][a-z0-9-]{0,39}$`. A module can't take a built-in harness's id (`pi`, `claude-agent`,
`codex`, `opencode`, `goose`) or one of the ids serve's own runs carry (`learning`, `sdk`, `workflow`,
`claude-agent-sdk`, `codex-sdk`). If it does, the server refuses to start and names the module and the id.

### The facts

The facts are the kernel's `AdapterFacts`: what your harness is, stated once. serve reads them and never branches on
your harness's name. The ones that change what an owner sees:

| Fact | What serve does with it |
| --- | --- |
| `wire` | Which models the harness is offered and which key rows name it. On `anthropic-messages` that is Anthropic's models, on the Anthropic and OpenRouter key rows; on `openai-responses`, OpenAI's, on the OpenAI and OpenRouter rows. |
| `ownModel` | Set it when the harness runs only its wire's vendor's models, never the gateway's default. |
| `normalizeModel` | How the model id is written for your provider (Anthropic's ids have dashes where OpenRouter's have dots). |
| `steer` | Whether a message sent mid-turn reaches the turn in flight. ACP has no steer, so an ACP agent says `false`. |
| `rerunsStarted`, `recoversCutAnswers` | Whether a call cut off by a crash may run again, and how many answers cut at the output limit it recovers. The conformance suite reads these and skips the cases they rule out. |
| `runMib` | One run's memory, measured. A server admits as many runs as fit in its memory. |
| `hostName`, `nativeTools` | How your harness names the host's tools, and which of its own tools are held to which tool setting (an `acme_shell` held to `bash`, say). |
| `policy` | What a model request may carry and where it may go on this server's key. |
| `install` | The line that installs the harness, and the error codes its setup carries. |

The example spreads Goose's own facts and changes the id and the label. Copy those of the built-in harness that is
closest to yours, then change what differs.

### How it starts: `kit.acpEntry` or `kit.adapterEntry`

An agent that speaks ACP (the Agent Client Protocol) runs on serve's own ACP adapter, `@parcha/agentrun-harness-acp`.
Give `kit.acpEntry`:
- `recipe(launch)`: how to start the agent for one run. It holds the command, its arguments, environment and files, the
  state folders that hold its sessions, what it declares (`load`: whether it resumes with `session/load`; `mcp`:
  whether our tools reach it over `http` or `stdio`), and how it is billed (`proxy`, or `plan` with a turn and tool-call
  bound). `launch.model` is the model serve chose for the run, already written the way your provider names it.
- `proxy(launch)`: the model proxy each of the agent's processes calls. The agent never holds a key: it holds the
  proxy's own key for the session, and the proxy books each request against the run's cap, then forwards it with this
  server's key. `gooseProxy` serves any agent that reads `ANTHROPIC_HOST` and `ANTHROPIC_API_KEY`. An agent on another
  wire needs an `AcpProxy` of its own.
- `beforeStart(command)`, optional: a check before each process starts, a restart included. The example checks the
  binary against its pin there.
- `promises`, optional: what the harness promises an owner, shown on its offer. The default is a resume by
  `session/load`, each tool call through the agent's permission ask, and billing through the proxy. An agent that
  can't load a session says `resume: "restart"`.

Any other agent runs on an adapter you write (the kernel's `AgentAdapter`). Give `kit.adapterEntry(facts, adapter)`,
where `adapter(launch)` builds it for one run. `launch` holds the model, where to forward its requests
(`launch.provider`: the origin, the credential and how it is sent), the price of a request's usage, a log, the
confinement its process starts under, and the server's environment.

For either one, serve picks the model and the key the way it does for its own harnesses. A person's Claude Code login is
never a module's credential.

### What no key fixes: `missing`

Give `missing(env)` for anything a model key can't fix. Most often that is the binary. serve asks it before the key.
When it returns words, the harness's offer says them and names no key. Without it, a harness that has neither its
binary nor a key would be offered as one that a key runs. The example returns, in words that end with what to do, that
no binary is named, or that the one named isn't the pinned Goose.

Settings of your own come from the server's environment (`launch.env` and `missing`'s `env`). The example reads its
binary's path from `EXAMPLE_GOOSE_BINARY`.

## Prove it

The conformance suite is the one this repository proves its own harnesses with. It comes from
`@parcha/agentrun-serve/conformance`:
- `registerHarnessConformance(subject, { test })` registers its cases on `node:test`.
- `createAdapterLoop(spec, { restartLimit: MAX_RESTARTS })` is the kernel's adapter loop, which runs every adapter
  harness, built-in or not.
- `suiteHostTools(tools)` gives the suite's tools to your session as host tools.

The subject runs your adapter in that loop. Its cases crash the run at each point that matters and check what happens:
before a tool's intent is recorded and after it, mid-answer, with the runner process killed, and with a run paused past
its lease. A tool that changes something must run at most once; a resumed run must pick up where it was. Your facts
say which cases your harness rules out, and the suite skips each of those with the reason.

An ACP agent's module runs the suite on `@parcha/agentrun-harness-acp/testing`. `fakeAgentRecipe(id, dir, script)`
starts a fake ACP agent whose model is the suite's script. It needs no binary, no model and no key, so the suite runs
before any real agent is in it. `examples/harness-module/test/subject.mjs` is the whole subject. Keep it in a module of
its own: the suite's process cases start a second runner process that imports it.

What the fake can't prove is your recipe and your proxy on a real agent. That is the [live run](#a-live-run).

### What passing looks like

```
ℹ tests 31
ℹ pass 25
ℹ fail 0
ℹ skipped 6
```

Each skipped case names why your harness doesn't do it by design. For an ACP agent: no steer, no rerun of a started
call, and no recovery of an answer cut at the output limit. Any other skip, or any failure, is yours to fix.

## Load it

On the server's machine, install the module into the server's data and name it at the start:

```sh
npm install --prefix <data>/harnesses <your-package>
agentrun-serve --data <data> --harness-module <your-package>
```

`--harness-module` can be repeated, and `AGENTRUN_SERVE_HARNESS_MODULES=a,b` does the same. A module can also be a
path. A separate `agentrun-serve runner` takes the same flag and needs it to run your harness. A module that isn't
installed refuses the start and names the command that installs it.

`GET /v2/capabilities` then lists your harness in `harnesses`, after the built-in ones, with its `label`, its
`promises`, and either `available: true` and the `keys` that run it, or `available: false` and the `reason`. Loading
your module changes nothing a built-in harness is offered: its models, key rows, default model and tool names are the
same as without it. Tests in serve hold that.

### A live run

Save an agent with `definition.harness` set to your id and run it on a cheap model. Set `AGENTRUN_TELEMETRY=0` on any
server you start for testing, so your test runs don't count as users. The run's events show your harness's tool calls,
and its cost line shows the requests your proxy booked.

## Send it

A module is yours to publish: an owner installs it by package name. To have it listed here, open a pull request that
adds a row to [docs/examples.md](docs/examples.md) with:
- the conformance output above, from your module's `npm test`;
- the id and cost line of one live run, and the model it ran on;
- what your facts rule out, in a sentence.
