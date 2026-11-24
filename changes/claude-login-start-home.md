---
packages: @parcha/agentrun-harness-claude
kind: breaking
---
`startClaudeLogin` no longer takes a `home` option. A host that calls it with `{ home }` sets that home on the login as `userHome` instead (`startClaudeLogin(cli, { ...login, userHome: home })`); the status check and a run on macOS read the same field, so one home serves all three. TypeScript flags a `home` option as an unknown property; from JavaScript it is ignored, and the sign-in runs in the login's own `home`, else the OS's home.
