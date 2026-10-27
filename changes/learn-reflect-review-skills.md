---
packages: @parcha/agentrun-learn
kind: feature
---
The package ships the loop's two skills, `skills/reflect/SKILL.md` and `skills/review/SKILL.md`, for any harness that can edit files and run git. Reflect, after every run, writes the memo on `runs/<run id>` (outside a host it fills the front matter from git and never guesses a cost), adds or updates notes and the index, adds a skill or workflow draft when the work repeats, and runs the checker before it pushes. Review, before a merge, runs the checker, requires the injection screen (outside a host only a person can stand in for it), asks the Pi curator's questions of each item, and merges with a merge commit whose message carries the verdict and its reason. Copy both into `.agents/skills/`, where the checker locks them.
- A memo may end with a fifth section, `## Review`, which the review writes: its verdict and the reason for each item it refused.
