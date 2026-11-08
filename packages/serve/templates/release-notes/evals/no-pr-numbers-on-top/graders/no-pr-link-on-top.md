---
type: regex
target: draft_markdown
pattern: "^(?:(?!## Changes by pull request)[\\s\\S])*?/(?:pull|issues)/[0-9]"
expect: no_match
---
No link to a PR or an issue above the "## Changes by pull request" heading either.
