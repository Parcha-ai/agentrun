---
type: llm
target: draft_markdown
---
PR 205 is "chore: bump toml_edit from 0.22 to 0.23", labelled `dependencies` and `chore`, with a one-line body. Its
only upgrade note is in its change fragment (`kind: breaking`): a `lantern.toml` with a duplicate key in one table is
now refused at start, where the last value used to win, so a user must remove duplicate keys before upgrading.

Pass only if all of these hold:

1. A line under "## Upgrading" says that duplicate keys in `lantern.toml` are now refused (or that Lantern no longer
   starts with them) and that a user must remove them. A line that only says a dependency was bumped does not pass.
2. The answer's JSON has an `upgrading` item with `breaking: true` whose `prs` includes 205.
3. PR 205 is not in `skipped`, and its `pull_requests` row has `upgrading` in `placed_in`, not `internal`.

Fail if any one does not hold.
