---
packages: @parcha/agentrun-serve
kind: fix
---
A standing rule for every reply or report that a run proposed as a skill is kept as a note: the grader judges it mis-kept (a skill loads only when a job calls for it, a note is served whole on every run) and re-files it, and the merge writes `<name>.md`, with the skill's description and body, in the skill's place, pending when risky. One that would be no note is dropped, saying it belongs in a note. A note of that name the agent already has is never written over, and never fails the learning: the same text is no change, and other text drops that rule alone, saying a note of that name exists, while the rest of what the run learned merges. The grader's verdict gains the decision `note`, a skill's alone. Upgrading: nothing to do.
