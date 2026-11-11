---
type: regex
target: draft_markdown
pattern: '\bagents?\b'
flags: i
expect: no_match
---
The word "agent" or "agents" appears nowhere in the draft: since v1.10.0 the rule is "assistant", never "agent".
