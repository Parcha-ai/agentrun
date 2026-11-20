---
packages: @parcha/agentrun-serve
kind: feature
---
`learning.repick: true` (off by default) has a learned workflow's quote re-pick read the pages its run fetched, sent as untrusted data to a step with no tools; `learning.repick_max_chars` (150,000 by default) caps what it sends. It reaches workflows compiled after it is set, and agents on an SDK bridge ignore it.
