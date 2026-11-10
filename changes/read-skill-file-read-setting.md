---
packages: @parcha/agentrun-serve
kind: fix
---
A codex or OpenCode run on the runner that reads a file of a skill its agent learned (`read_skill_file`) runs under the `read` setting: by default the read runs with no approval, where before the run parked waiting for one, and a server or agent that denies `read` refuses it in the words naming `read`'s setting. On OpenCode, an agent's own MCP tool whose name happens to be `read_skill_file` keeps its own MCP setting. The gate judges the setting only; the skill reader still refuses a path that climbs or is absolute.
