---
packages: @parcha/agentrun-serve
kind: fix
---
After a grade's feedback round, or a person's follow-up on an ended run, the Timeline shows the round's rows first and then the learning row ("Learned: …"), as it does after a server restart. Before, the live Timeline kept the learning row where it was when the run first ended, above the reviewer's words.
- The timeline's change log now serves rows in the order the run's rows come in: a row the rows now hold after a row served later than it gets a new `seq`, sent as a change, so a reader from a cursor and a fresh read from `after=0` agree. The usage row still goes last.
