---
packages: @parcha/agentrun-serve
kind: fix
---
The learning grader reads a long user message as its start and its last 300 characters, with a line between saying how many characters were left out, where it read only the first 1,000. A rule the user took back at the end of a long message ("actually no, never include those") now reaches the grader, so a note that keeps the rule they withdrew is no longer kept as theirs. Each message is still cut of the server's secrets whole before it is shortened. Upgrading: nothing to do.
