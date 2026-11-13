---
type: regex
target: draft_markdown
pattern: "## Upgrading\\n(?:(?!\\n## )[\\s\\S])*duplicate"
flags: i
expect: match
---
The "## Upgrading" section (up to the next "## " heading) names the duplicate-key change from PR 205's fragment.
