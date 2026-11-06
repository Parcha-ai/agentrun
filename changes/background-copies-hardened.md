---
packages: @parcha/agentrun-serve
kind: fix
---
The background tools' display copies in `work/background/<id>/` hold up against what a running command plants there, and the answers name what actually happened.
- A copy's temporary file now has a name no one can guess and is created and written in one exclusive open, so it is never written through a link swapped in after it was made. A real directory standing at a display name skips that copy, instead of the copy moving into it.
- At the run's end, `command` and `started` are written again along with `exit` and `ended`, so a link planted at one after the start does not stay in the run's files.
- A directory in `work/background/` that the box never started reads as "was not started in this box (only its files in work/ remain)". It used to get the words for a process whose box was replaced.
- A refused `output.log` names only the cause that applied: a link or a non-file, or a box with no `/proc` to check by.
