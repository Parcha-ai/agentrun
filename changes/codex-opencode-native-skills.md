---
packages: @parcha/agentrun-serve
kind: fix
---
A codex or opencode run now gets its skills, the revision's and the ones its agent learned, as the harness's own, as a claude-agent run does. Codex lists them from its session's skills folder, OpenCode's instructions name them, and the model reads a skill's files with `read_skill_file`. Each adapter could take skills since #1313, but serve never handed them over, so Codex's own skills list stayed empty. The run's prompt gave each skill only as a name and a path, and the model had to choose to open it. A learned skill that said how to write every report was never read. A skill the adapter's own check refuses stays in the prompt as before.
