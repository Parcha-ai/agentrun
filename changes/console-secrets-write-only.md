---
packages: repo
kind: feature
---
The console treats secrets as write-only, the same way on every page that holds one. Each secret (a model or tool key's field, an MCP server's token or header value) is one row: its name, Set or Missing, where it comes from ("Set in the environment", greyed, with nothing to paste over it; "Pasted here"; "From sign-in"), and when it last changed. Paste, Replace and Remove appear only on the owner's password session (GET /v2/auth/session's `secrets_writable`); otherwise the page says "Sign in with your password to change secrets." once, the model-key card offers no key to paste, and an MCP server's form offers no bearer token, header values or OAuth client secret. No value is ever shown.
