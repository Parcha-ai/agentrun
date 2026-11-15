---
packages: @parcha/agentrun-serve
kind: fix
---
A wrong grade with no words no longer tells the model the verdict twice in each ask. The round's steer carries only the words, else "A right answer holds: {…}", else "(no words)" (the Timeline's "Your grade" row reads the same); the look-back and revise asks each say the verdict once.
