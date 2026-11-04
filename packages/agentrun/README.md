# @parcha/agentrun

Start AgentRun on your machine with one command:

```sh
npx @parcha/agentrun
```

It starts [AgentRun Server](https://github.com/Parcha-ai/agentrun/tree/main/packages/serve) on the first free port from
7340 on this machine's loopback, keeps its data in `~/.agentrun`, prints the address the server says to
open and opens it in your browser (`--no-open`, a CI run or a machine with no display skips that). The first run fetches
the server's latest release, `@parcha/agentrun-serve`; this package has no dependencies of its own. If that download
fails, it says so and starts nothing. Node.js 22.19 or newer on 22, or 24.2 or newer, on macOS or Linux.

pi runs every agent out of the box. The Claude Code and Codex harnesses need their own packages beside the server; when
one is missing, AgentRun says so with the one command to paste: `npx` with this package, the server and that harness's
package at their versions, with `--data` naming the same store.

With `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in your environment and no `AGENT_MODEL`, the server
runs a current model of that provider. Other commands are the server's: `npx @parcha/agentrun import` brings in your
local Claude Code, Codex and pi sessions, and `npx @parcha/agentrun reset-password` clears the console's password.
`--data DIR` and `--port N` change where it keeps its data and the port it takes.

The TypeScript SDK for the hosted AgentRun API is published as `@parcha/agentrun` 0.2.x, from its own repository; this
package starts with 0.3.0, so a dependency on `^0.2` keeps the SDK.
