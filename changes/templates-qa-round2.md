---
packages: @parcha/agentrun-serve
kind: fix
---
Template fixes from human QA:
- `code-review` and `release-notes` refuse a repository with a trailing dot (`acme/widgets.`): `repo` is owner/name ending in a letter, digit, `-` or `_`.
- `code-review` reads no repo file when it reviews a pasted diff with no repository behind it, instead of failing reads of `REVIEW.md`, `AGENTS.md`, `.pr_agent.toml`, `.git/` and the changed files; it says the repo's own rules were not read.
