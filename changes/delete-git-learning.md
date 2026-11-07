---
packages: repo
kind: breaking
---
`@parcha/pi-agent-learn` and `@parcha/pi-git-remote` are deleted from the repository, with the `examples/agent-learn` demo (`npm run demo:learn`) and the guide's "An agent that learns" section. No other package imports either one, so nothing else changes. Neither is published again: their last versions on npm stay installable and are deprecated there. A program that uses them keeps working on the last published version; a server's agent learning (agentrun-serve's learning folder) is unaffected.
