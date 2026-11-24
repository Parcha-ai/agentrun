---
packages: @parcha/agentrun-harness-claude
kind: breaking
---
The harness's Claude login (`ClaudeAgentLogin`) no longer has the `shared` flag 0.1.0-beta.56 gave it. Every status check now runs the CLI on a copy of the account file, as a check on a login marked `shared` did, so the flag has nothing left to choose. A host that set it drops it. TypeScript flags `shared` in a login written as an object literal as an unknown property; from JavaScript it is ignored.
