---
packages: @parcha/agentrun-serve
kind: feature
---
A learned note must hold beyond the one input it came from, and a run past the learning budget reads the notes that bear on it whole. Before the grader, one Jev question per new note (the Jev model and keys decision nodes use) asks whether it states a method, a source, a fact or a preference that holds for the job's other inputs; a note rated below 0.5 (`AGENTRUN_SERVE_LEARNING_GENERAL_THRESHOLD`, 0 to 1) is dropped there, its reason on the verdict, and when Jev cannot run the grader reads every note. The grader now answers `general` for every item, and an item it says is not general is never kept. Past the budget, whole notes take the room before rule lines do, so an agent with hundreds of notes no longer gets one line per note and nothing whole; the notes the section leaves out are named in the run's log and kept on its launch (`learning.notesLeftOut`). A learning budget of 0 now serves no notes.

Upgrading: nothing to do; set `AGENTRUN_SERVE_LEARNING_GENERAL_THRESHOLD=0` to keep every note the grader passes.
