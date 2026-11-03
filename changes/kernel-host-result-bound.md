---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A host tool's result reaches a harness at most `HOST_RESULT_MAX_CHARS` (120,000) characters long. The kernel's tool bridge, which every host tool's result passes on its way to Claude Agent or Codex, keeps a longer one's start, cut where a character ends, ends it with a line saying where it was cut (`[cut at N of M characters]`), and flags the call's `tool_end` `truncated: true`; the call's record keeps the whole result. A skill file read with `read_skill_file`, a delegate's answer and a rejection listing every schema error reached the harness whole, however long (a 1 MiB skill file, a 6 MB answer).
