---
packages: @parcha/agentrun-learn
kind: feature
---
`@parcha/agentrun-learn` is no longer held: its manifest drops `"private": true`, so a release publishes it to npm under the `beta` tag, at the workspace version, after `@parcha/pi-git-remote` and before `@parcha/pi-agent-learn`, which depends on it. Its README's install line is `npm install @parcha/agentrun-learn@beta`.
