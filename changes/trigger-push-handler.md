---
packages: @parcha/agentrun-serve
kind: fix
---
Every pushed trigger source is served by one handler at `POST /v2/hooks/{trigger_id}` (a source whose settings are a trigger's, the webhook) or `POST /v2/hooks/{source}` (one whose settings are the server's), with no token, in one order: headers, the body cut at the source's limit (413), its check against its settings, its handshake, its parse. Every refusal is the one 401. A request that passes its check but is no event its source takes, or names no trigger of it, is answered 200 and said in the log (`hook_unparsed`, `hook_no_trigger`), never swallowed; a hook path that does not decode is said as `malformed_path`. The webhook trigger answers as before. Upgrading: nothing to do.
