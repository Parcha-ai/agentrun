---
packages: @parcha/agentrun-serve
kind: fix
---
A standing rule for every reply or report that a run proposed as a skill is kept as a note: the grader judges it mis-kept (a skill loads only when a job calls for it, a note is served whole on every run) and re-files it, and the merge writes `<name>.md`, with the skill's description and body, in the skill's place, pending when risky. One that would be no note is dropped, saying it belongs in a note. At the merge, any note the run keeps (a re-filed skill's too) whose name the agent's notes already hold, another run having merged one meanwhile say, no longer fails the whole learning run: the same text is no change; a note that supersedes the note of its own name replaces it; any other is left out alone, saying a note of that name was added since or was there already, and the rest of what the run learned merges. The grader's verdict gains the decision `note`, a skill's alone. Upgrading: nothing to do.
