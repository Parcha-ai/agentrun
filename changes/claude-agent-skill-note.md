---
packages: "@parcha/agentrun-harness-claude"
kind: fix
---
A claude-agent session with skills now tells its model that the Skill tool is its own and when to load a skill. The tools note said the app's `mcp__hands__` tools were the model's only ones, so a model that read it had no reason to call Skill, and template agents often skipped their SKILL.md. Measured on two watch templates (Claude Sonnet 5.5, 6 runs each): skill loads went from 2 of 6 and 0 of 6 to 6 of 6 and 4 of 6.
