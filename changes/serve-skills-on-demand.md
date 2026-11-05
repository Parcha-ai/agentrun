---
packages: @parcha/agentrun-serve
kind: feature
---
On `pi`, `codex` and `opencode`, a run that reads its files (the `read` or `bash` tool) gets its skills on demand, as `claude-agent` does through its Skill tool: its system prompt names each skill, what it is for and its `SKILL.md`'s path under `.agents/skills/`, and the agent reads the file when the skill fits the step it is on. The revision's own skills and the ones the agent learned alike. A run with neither tool gets every `SKILL.md` inlined, as before.
 A skill's front matter description is read whole as YAML folds it: one that wraps onto indented lines, or one written entirely on the next lines.
