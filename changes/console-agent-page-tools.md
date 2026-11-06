---
packages: repo
kind: fix
---
An agent's page lists the tools its current revision grants, among its facts: each tool's name, its provider where it has a choice of one, and its permission, as in force for that agent (its own setting over the server's), such as "web_fetch · Parallel · ask". An agent with no tools says "none". Before, only its Edit page named them. After a save on the page (the Learning switch), the page shows the saved setting at once and reads the agent again; if that read fails, it says "Couldn't refresh this agent." with a Retry.
