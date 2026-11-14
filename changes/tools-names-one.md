---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A tool row on a run's timeline carries the call's catalog name (`mcp:notes5/write_note`, `monid:faux/person/enrich`), not the wire name the harness called it by (`mcp__notes5__write_note`). Runs recorded before this show the same names now: the rename is made when the timeline is read.
- Each harness's facts state their own map from the model's name for a host tool to the host's (`AdapterFacts.hostName`, replacing OpenCode's `toolAlias`), and the tool gate and the meta tools read it instead of stripping prefixes.
- One conversion turns a host tool into the tool bridge's (`bridgeTool`, from `@parcha/agentrun-kernel/process`); the Claude Agent, Codex and OpenCode adapters each add only what is theirs.
