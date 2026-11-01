---
packages: @parcha/agentrun-serve
kind: feature
---
A `claude-agent` run loads the revision's skills through the Claude Agent CLI's Skill tool instead of reading them all in its system prompt. The model is shown each skill as `agentrun:<name>`, loads its `SKILL.md` when it needs it, and reads the skill's other files with `read_skill_file`; the system prompt carries the instructions alone. A skill the adapter does not take (a name that is not lowercase letters, digits and dashes, a `SKILL.md` without front matter giving its `name` and a `description`, a file path that is not plain or is deeper than five segments) stays inlined in the system prompt as before, and so do all of them when together they hold more than 1 MiB. The check is the adapter's own `skillProblems`, so a run is never refused for a skill serve took. `pi` and `codex` runs still inline every skill.
