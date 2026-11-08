---
packages: repo
kind: fix
---
The agent editor's Tools step says which harnesses run a tool the form's harness doesn't, by the names the Harness step shows ("Runs on Pi here, not on Claude"), from the server's `capabilities.tools[].harnesses`, and disables its tick with that reason, so Save never refuses it later. The run page's Report tab reads a budget pause's cap as always served, and a run waiting on the person in the browser says so with the server's instruction, never that a reply below answers it. The console no longer keeps a rule of its own for which harness runs a tool.
