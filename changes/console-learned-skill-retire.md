---
packages: repo
kind: feature
---
The console's Learning tab retires a learned skill or a workflow draft as it retires a note. An active or waiting skill and a draft workflow have Retire, behind the notes' confirm in place ("Retire it? Later runs stop getting it. It stays under Earlier skills."), made on the listing's version of its `SKILL.md` or its draft's `README.md` (never its `workflow.json`). A retired one moves under Earlier skills or Earlier workflows, closed until asked, with no Approve and no Retire, and is no longer counted as in use. A version changed since the listing (412) says "It changed since you opened it. Reload the tab to see the newest version.", as a note does.
