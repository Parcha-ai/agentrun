# @parcha/agentrun

Start AgentRun on your machine with one command:

```sh
npx @parcha/agentrun
```

It starts [AgentRun Server](https://github.com/Parcha-ai/agentrun/tree/main/packages/serve) on the first free port from
7340 on this machine's loopback, keeps its data in `~/.agentrun`, prints the address the server says to open and opens
it in your browser (`--no-open`, a CI run or a machine with no display skips that). The server,
`@parcha/agentrun-serve`, is this package's one dependency, at its exact version, so `npx` installs the two together and
each version of this command runs the server it was released with. Node.js 22.19 or newer on 22, or 24.2 or newer, on
macOS or Linux.

Where Docker answers on this machine, a new agent runs in a Docker box of its own with a shell, and a line on stderr,
after the address, says so: `Boxes: docker (on by default; set AGENTRUN_BOXES to change).` Where it does not, that line says why
and that new agents run on the runner. The box image's first build takes a few minutes, said as it starts (`Preparing
the Docker box image (first start only, a few minutes); agents can be made now, and their first run waits for it.`)
and as it ends (`The Docker box image is ready.`). `AGENTRUN_BOXES=none` turns boxes off.

pi runs every agent out of the box. The Claude Code and Codex harnesses need their own packages beside the server; when
one is missing, AgentRun says so with the one command to paste: `npx` with this package, the server and that harness's
package at their versions, with `--data` naming the same store.

With no `AGENT_MODEL`, the server runs a current model of the first provider it has a key for, Anthropic, then OpenAI,
then OpenRouter: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in your environment, or a key saved in
the console's Settings → Model keys, which counts from the save on. Other commands are the server's:
`npx @parcha/agentrun import` brings in your local Claude Code, Codex and pi sessions, and
`npx @parcha/agentrun reset-password` clears the console's password. `--data DIR` and `--port N` change where it keeps
its data and the port it takes.

Every other command is the server's API, from a second terminal: `npx @parcha/agentrun agents list`,
`agents create --body @agent.json`, `runs start AGENT_ID --max-cost-usd 2 --body '{"input":{"content":"..."}}'`,
`runs get RUN_ID`, `runs message RUN_ID --content "..."`, and one command for each route the server serves
(`npx @parcha/agentrun help` lists them; `api METHOD PATH` calls any route). It finds the server started with the same
`--data` on its own: the server writes its address and where its token is to `DIR/.server.json` once it listens. For
another server, set `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`. The response's JSON goes to stdout and an error's to
stderr; the exit code is 0 when it worked, 1 when the server refused, 2 for bad usage, 3 when the server cannot be
reached and 4 for a missing or refused token. The token is never a flag and never printed.

The TypeScript SDK for the hosted AgentRun API is published as `@parcha/agentrun` 0.2.x, from its own repository; this
package starts with 0.3.0, so a dependency on `^0.2` keeps the SDK.
