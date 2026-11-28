---
packages: @parcha/agentrun-serve
kind: fix
---
The code-review template (and code-review-composio, generated from it) ranks a finding it can't fully show at P2 at most. A reviewer that is unsure an input reaches the line, or that a fact it didn't read stops it, keeps the finding hedged: P2 at most, `confidence` 0.6, and a `failure` carrying the literal `Not shown: <fact>`. When reviewers' findings merge, one whose `failure` says `Not shown:` stays P2 at most, whatever priority another reviewer gave it. A change that gives the usual inputs a different result than the old code did, not only an odd one, shows its own failure in the diff and is never hedged. Before, a hedged finding could reach P1 and raise the risk score to 3. The `re-review` eval case states this rubric in one grader (`resolves.md`).
