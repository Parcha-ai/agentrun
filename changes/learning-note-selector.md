---
packages: @parcha/agentrun-serve
kind: feature
---
Which of an agent's notes a run is given is now one choice behind a port, `NoteSelector` (`learning.ts`): it reads the run's input and each note's size, and picks the notes the run reads whole and whether it reads the index. The default, `byRecency`, gives exactly what runs got before (every note whole while all fit the learning budget, else the index and the newest notes that fit), so nothing a run reads changes. The run's `# Learned` section and the notes it is given come from one choice.
- Upgrading: nothing to change.
