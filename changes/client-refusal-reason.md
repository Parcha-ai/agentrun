---
packages: @parcha/agentrun-client, repo
kind: fix
---
The TypeScript and Python clients' refusal messages now include the server's reason. Before: `The server refused GET /agents: 422 invalid_input.` After: `… 422 invalid_input: name is taken`. The reason comes from the error object the client already keeps (the API key cut from it), on one line, at most 300 characters. After a request whose body carried a secret, it stays the code alone.
