---
packages: @parcha/agentrun-serve
kind: fix
---
What a run learns is kept item by item. The grader's verdict was read as all or nothing: when it dropped one note and kept another, nothing merged. Now the notes, skill and workflow draft it keeps (or holds for the owner's OK) merge and the ones it drops are left out, and the run's learning names the first one left out. A drop on Planted still keeps nothing from the run, and a grader that keeps every item and says no merge still merges nothing. The checks before the grader work the same way: a note out of shape is left out and the rest goes on (named in the run's learning `problems`), while a secret, a count over its cap, a deletion or a path outside the folder still refuses the whole proposal. And a run's note with no `type:` is a project note, as Claude Code's memory reads one, where it used to drop the whole proposal.
