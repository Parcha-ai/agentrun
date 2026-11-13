---
type: regex
target: draft_markdown
pattern: "(?:^|\\n)## Changes by pull request\\n"
expect: match
---
The draft has the "## Changes by pull request" heading, so the two checks above have something to stop at.
