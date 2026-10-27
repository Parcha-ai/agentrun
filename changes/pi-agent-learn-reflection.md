---
packages: @parcha/pi-agent-learn
kind: feature
---
A Pi run's memo can carry the agent's own reflection. After the run's answer, a host sends `REFLECT_PROMPT` as one more message in the same conversation; `parseReflection(reply)` reads the reply's `## What happened` and `## What could be better`, and `proposeLearning({ reflection })` writes them under the host's front matter, in place of the host's own lines.
- A reflection out of shape (`reflectionProblem`: a section empty, over `REFLECTION_CHARS` (2000) characters, holding a heading or a `---` line, or a control or invisible character), or one in which the guard finds a secret or this case's data, is not written: the host's lines stand, the notes are proposed as usual, and the result's `withheld` names `reflection` with the reason.
- `curate` screens the memo with the run's notes, skills and drafts. A memo the screen refuses still lands, rendered by the host (`hostRenderedMemo`): its checked front matter, a line saying why, host lines in the other sections and the paths it named under `## Proposed changes`, with no text of the run's and no Review it wrote. It refuses no candidate.
