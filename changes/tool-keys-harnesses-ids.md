---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
`GET /settings/tool-keys` (`listToolKeys`) names a key row's harnesses by harness id: `items[].harnesses` is an array of strings (a harness id, `HARNESS_ID_PATTERN`), no longer of the four built-in names, since a harness its owner installs (`goose`) is named there once it is installed. The TypeScript client's and the console's types say `string[]`, and so does the Python client.
Upgrading: a caller that switched over the four names (`pi`, `claude-agent`, `codex`, `opencode`) handles any other id too, for example by showing it as given.
