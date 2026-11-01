---
packages: @parcha/agentrun-serve
kind: feature
---
Each agent has a learning repository, `DATA/homes/<agent id>/learning/` (plain git, `main` checked out, laid out as `packages/learn`'s SPEC says), made when its first agentic run is made, and every agentic run on pi, claude-agent or codex starts from its `main`. The commit is pinned in `runs/<id>/learning.json` and kept through a resume or a follow-up; its `.agents/skills/<name>/SKILL.md` files are prompted after the revision's skills (the revision's wins a name clash); and a `learnings/INDEX.md` that holds a note goes into the run's instructions in a `<learned>` section. The server is the repository's only writer, with hooks, fsmonitor, lazy fetches and system and global config off. A host without git 2.40 or later runs agents with nothing learned.
