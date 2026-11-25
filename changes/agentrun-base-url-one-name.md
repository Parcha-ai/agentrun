---
packages: @parcha/agentrun-serve
kind: fix
---
A server's address has one name in an app's environment, `AGENTRUN_BASE_URL`, the name AgentRun's clients and CLI read. A suggested agent's pull request and client file, the two lines the console's AgentRun API keys page copies, and the Suggested agents page's "Set in your app's environment" list all named it `AGENTRUN_URL`, so an app that also used the SDK or the CLI held the same address under two names.

- Each of them now gives the value the server prints when it starts: the address ending in `/v2`. The page of HTTP calls written for a language with no client adds no `/v2` to its paths.
- A suggested agent's client (TypeScript, JavaScript or Python) reads `AGENTRUN_BASE_URL` and takes it with or without `/v2`, trailing slashes cut, as the SDK does. An address that is no `http` or `https` URL is refused by the variable's name before anything is sent.
- A client file from a pull request opened before this release still reads `AGENTRUN_URL`, as its own header and its pull request say. An app with one of each sets both: `AGENTRUN_URL` stays the address without `/v2`, which that file adds itself. A create whose branch was pushed before this release and whose pull request GitHub refused opens that pull request now: its text says `AGENTRUN_BASE_URL` while the pushed file reads `AGENTRUN_URL`.
