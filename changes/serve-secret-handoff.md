---
packages: @parcha/agentrun-serve
kind: fix
---
The server's secrets are out of every process's environment. `agentrun-serve`, the bin and the image's entrypoint, is now a small launcher. It hands the server each secret it names over a pipe and starts it with `env -u` for each, so none is in the server's `/proc/<pid>/environ` or command line. The secrets are the API token, `AGENT_MODEL_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `BROWSERBASE_API_KEY`. The server reads the pipe first thing and closes it, and hands each run's process its own secrets over a pipe of its own, never its environment. In the image, PID 1 is still tini, started by the launcher. Capabilities' `secrets` says how secrets are held and the limit: in memory, they rely on the kernel refusing a process of the same user to attach (Yama `ptrace_scope` 1 or more). Operators still set the same variables. Started as `node dist/cli.js`, the server reads them from its environment, as before.
