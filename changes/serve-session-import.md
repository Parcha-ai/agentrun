---
packages: @parcha/agentrun-serve
kind: feature
---
**`agentrun-serve import`: your Claude Code, Codex and pi sessions as agents and their runs**
- `agentrun-serve import [--data DIR] [--from claude-code,codex,pi] [--dry-run] [--all]` reads the sessions in your own home (`~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions`) into the agent store, once, when you run it. Nothing leaves the machine.
- Each project directory becomes one agent. Each harness seen in it becomes one revision: `claude-agent`, `codex` or `pi`, on that harness's latest model. Its instructions are the project's `CLAUDE.md` or `AGENTS.md`, and its skills are the project's skill folders (`.agents/skills`, `.claude/skills`, `.codex/skills`, `.pi/skills`), file by file. Every file is read through no link and within a size cap. A link, a binary file, an oversized file or a folder with no `SKILL.md` is left out, and the report names it.
- Each session becomes one run, ended as it ended (`completed`, `failed` or `stopped`), at its own times, with its transcript as the run's timeline. Its cost is the source's when it records one (Claude Code's session cost, the sum of pi's request costs); otherwise it is unknown, never 0.
- An imported run is history. A message to it is `409 not_continuable` with `details.reason` `imported`. A stop or a cancel answers as for an ended run and writes nothing. The run and its summary carry `imported_from` (`x-agentrun-serve: imported/1`).
- The values of key-shaped environment variables (`*_API_KEY`, `*_TOKEN`, `*SECRET*`) are cut out of everything written, and each run's files are the owner's only (0600 in a 0700 directory).
- Run again, it imports only the sessions it does not hold. A session written in the last 10 minutes waits for the next import. Subagent sessions are not imported. Projects whose directory is gone or temporary are left out unless `--all`. `--dry-run` lists each project and writes nothing.
