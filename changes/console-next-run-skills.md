---
packages: repo
kind: fix
---
Console: an agent's Learning tab, under "What the next run reads", counts and names the agent's active skills beside the notes in use: "1 skill", "2 notes · 1 skill", and, opened, "Active skills: find-policies". An agent whose only learning was an approved skill read "nothing" there, though later runs get that skill. A skill that waits for its owner's OK is still left out, and with learning off (for the agent, or on the server) the panel says the next run gets no notes or skills. A long skill name wraps inside the panel.
