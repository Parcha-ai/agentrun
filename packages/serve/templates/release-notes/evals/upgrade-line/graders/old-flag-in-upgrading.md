---
type: regex
target: draft_markdown
pattern: "## Upgrading\\n(?:(?!\\n## )[\\s\\S])*--out\\b"
expect: match
---
The "## Upgrading" section (up to the next "## " heading) names the old flag `--out` itself, not only `--output`.
