---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A Composio trigger's config seals addresses that carry a credential, and stops sealing counts.
- A credential word right next to a count word names a count, so `max_tokens`, `token_count`, `token_limit`, `tokens_used` and `maxTokens` stay as they are, a number in one too. `access_token`, `token`, `api_tokens`, `refresh_token`, `token_secret` and `bot_token` are still sealed. A field the event's schema marks as a password is sealed whatever its name.
- An `http` or `https` address with a password in its user part, or with a query parameter named like a credential (`token`, `api_key`, `access_token`, `sig`), is sealed whole, whatever its field's name. A create with one below the config's top level is refused `422`; one an earlier server kept is masked on reads and sealed at the next start. An address with neither stays as it is.
- After a start, the server reads the schema of each event an older trigger uses, once, and seals the fields it marks, logging `composio_config_sealed`. When Composio can't be reached, it logs `composio_config_schemas_unread` once with a code and tries again at the next start. The start doesn't wait for this.
- A field named `sig` is now sealed.
