---
packages: @parcha/agentrun-codex, @parcha/agentrun-adapters
kind: feature
---
**The Codex adapter takes the host's skills, and its sessions no longer see Codex's bundled ones**
- `codexAdapter({ skills: [{ name, files }] })`: Codex lists each skill to the model by its name and description, and the model reads its `SKILL.md` and its other files with `read_skill_file`, the shared read-only host tool (Codex has no shell here). The skills are written into each session's `CODEX_HOME` at the start of every drive, where Codex lists a user's skills in a turn with its built-ins off; it lists none from a working directory's `.agents/skills` there. A host tool named `read_skill_file` is refused when the adapter has skills.
- Codex's bundled skills (imagegen, openai-docs, skill-creator, skill-installer) are off in every Codex session, with skills or without (`[skills.bundled] enabled = false`). Before, Codex installed them at every start and listed them to the model, so a session was shown skills its host never gave it.
- The skills are checked when the adapter is made, and a bad one throws before the binary is looked for. The check, `skillProblems`, and the skill's shape, `HostSkill`, are now in `@parcha/agentrun-adapters` beside `readSkillFileTool`. The Claude adapter's `skillProblems` and `ClaudeAgentSkill` are that check and shape, re-exported, so nothing changes for its users; the Codex adapter exports the same `skillProblems`.
- The local Codex machine takes a seed of files for one of its private directories (`seed: { dir, files }`, each file's text by its relative path), written at acquire and again after every wipe. A path that is absolute, empty, climbs or starts with a dot, or a directory not the machine's own, is refused when the machine is made.
