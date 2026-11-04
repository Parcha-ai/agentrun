---
packages: repo
kind: fix
---
The console's agent editor fits a 375 px phone: the agent's name keeps the row, with its kind, revision count and Archive in a row under it, and the step rail shows step numbers (each step's name heads the step, and stays for screen readers). An agent with no web tool, such as one that only reads and writes files, is no longer told on every step that it can't reach the web: the Tools step says so, quietly, in the same words.
