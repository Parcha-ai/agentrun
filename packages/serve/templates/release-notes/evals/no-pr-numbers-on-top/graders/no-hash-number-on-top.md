---
type: regex
target: draft_markdown
pattern: "^(?:(?!## Changes by pull request)[\\s\\S])*?#[0-9]"
expect: no_match
---
No `#` followed by a digit (a PR or issue number) anywhere from the start of the draft to the "## Changes by pull
request" heading. Headings' own `#` marks are fine: they are followed by a `#` or a space.
