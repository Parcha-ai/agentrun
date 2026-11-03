---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run works in the run's workspace, the directory its file tools write to. Before, the CLI's working directory was an empty one beside it (`runs/<id>/harness/work`): Claude told its model that path, so a file written at its absolute path was refused as "outside the workspace", and the answer quoted the server's data directory. In QA this happened in 3 of 4 Claude runs that wrote a file.
- `SessionIO.cwd`: a host may name the session's working directory, its workspace. The Claude and Codex adapters run their CLI there, and keep their own state in the session's private directory as before. git stops at the workspace's parent. serve passes the run's `work/`.
- A file tool's refusal, an error such as ENOENT, and a write's or edit's result on claude-agent and codex name paths in the workspace relative to it (`notes/a.md`, `../escape.md: outside the workspace`), never by the server's data directory. A read's result is the file's own text and is not changed.
