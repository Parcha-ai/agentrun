---
packages: @parcha/agentrun-serve
kind: fix
---
The learning grader now reads every message the user sent in the run, each up to 2,000 characters and 40,000 in all, where it read only the first and the newest three. A note that claims the user's words from a message in between is checked against that message. A run past the total keeps the first and the newest messages, and the grader is told which ones were left out; what it cannot find in the messages shown is not the user's. What the user asks to keep for one time only ("this week only") is not general, and a note the user asked to keep that the grader drops as not general is now dropped, where it was held for the owner's OK. Upgrading: nothing to do.
