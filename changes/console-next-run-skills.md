---
packages: repo
kind: fix
---
Console: an agent's Learning tab, under "What the next run reads", counts and names the learned skills the next run is given, the active ones, beside the notes in use: "1 skill", "2 notes · 1 skill", and, opened, "Skills it's given: find-policies". An agent whose only learning was an approved skill read "nothing" there, though every later run gets that skill. A skill that waits for its owner's OK is given to no run and is still left out.
