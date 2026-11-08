---
packages: @parcha/agentrun
kind: fix
---
`agentrun server mcp --method tools/list` is a valid JSON-RPC request: a body built from flags alone carries `jsonrpc` "2.0" (the document's const) and `id` 1, and a whole `--body` is sent as given. `npx @parcha/agentrun frobnicate`, or any first word that is neither a command of the CLI nor one of the server's (import, reset-password, validate-template), says there is no such command and lists the commands, exit 2, instead of printing the server's usage. A started server's refused requests (wrong or missing token, wrong password) and verified webhook deliveries its trigger does not take are said on stderr in plain words, route and reason, each once.
