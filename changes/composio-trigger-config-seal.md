---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A Composio trigger's config field named like a credential is now sealed when the trigger is saved. This covers names like `developer_api_key`, `api_key`, `client_secret`, `access_token` and `password`: any field where a word of the name is secret, password, passwd, passphrase, token, credential or apikey, or where the last word is key, and the value is a string. The value is kept in the composio source's sealed settings, next to the subscription's secret. Composio still receives it when the server creates the trigger instance. Every trigger answer (create, GET, list, PATCH, template apply) shows `"[sealed]"` in place of the value and names the field in the source's new read-only `sealed_config`.
- A PATCH that leaves a sealed field out, or sends `"[sealed]"`, keeps the value. Sending a different value is a config change and is refused, as any config change to a composio trigger already is.
- Deleting the trigger removes its sealed values. At start, a trigger saved before this release with such a value in plain text is sealed, and its Composio instance is not changed.
- The events list (`GET /v2/settings/mcp-servers/{name}/composio/events`) names each event's sealed fields under `sealed`, and the console's form takes those as password inputs. A trigger's page shows them as sealed.
- Composio's error text for a failed create no longer repeats a sealed value.
- An Idempotency-Key's record in the data directory now keeps a SHA-256 digest of the request body, not the body itself. Records written by an older server are converted when they are read.
