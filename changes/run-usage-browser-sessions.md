---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
`GET /v2/runs/{run_id}/usage` gives `browser_sessions`: one record per browser session the run opened, with the provider's session id, when the server opened it and let it go, why it ended, the seconds charged for it, and the provider's own record of it (`provider_record`: its start, end and proxy bytes), read once when the session is let go, for reconciling `browser_time` with the provider's bill. A provider that keeps no record, or a read that fails, says so in `provider_record_status`, with the record null, never zeros. In the computer package, a browser provider may offer `sessionUsage(ref)`, the vendor's record of a session; Browserbase's reads `GET /v1/sessions/{id}`.
