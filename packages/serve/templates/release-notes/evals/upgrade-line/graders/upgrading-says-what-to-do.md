---
type: llm
target: draft_markdown
---
Pass only if all of these hold:

1. The draft has a "## Upgrading" section, and a line in it says that `lantern search --out` is now `--output` (or that
   `--out` is no longer accepted) and that a user must rename it in their scripts or commands. A line that only says
   "flag names were tidied" or "flags are more consistent" does not pass.
2. The answer's JSON has an `upgrading` item with `breaking: true` whose `prs` includes 201.
3. The draft's intro does not hide it: either the Upgrading line is the first in its section, or a "**Before you
   upgrade:**" line names the flag rename.

Fail if any one does not hold.
