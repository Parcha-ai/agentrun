---
packages: @parcha/agentrun-serve
kind: fix
---
A server's address has one name in an app's environment, `AGENTRUN_BASE_URL`, the name AgentRun's clients and CLI read. A suggested agent's pull request and client file, the two lines the console's AgentRun API keys page copies, and the Suggested agents page's "Set in your app's environment" list all named it `AGENTRUN_URL`, so an app that also used the SDK or the CLI held the same address under two names.

- A suggested agent's client (TypeScript, JavaScript or Python) reads `AGENTRUN_BASE_URL` and takes what the SDK takes: the server's address with or without `/v2`, trailing slashes cut. The page of HTTP calls written for any other language names the same variable and says when to leave `/v2` out of a path.
- A client file from a pull request opened before this release still reads `AGENTRUN_URL`, as its own header and its pull request say. An app with one of each sets both variables to the same address, or changes the older file's one line to read `AGENTRUN_BASE_URL`.
