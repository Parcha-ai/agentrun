---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
`GET /v2/runs/{run_id}/usage` gives `browser_sessions` (`runusage/2`): one record per browser session the run opened, with the provider's session id, when the server opened it and let it go, why it ended, the seconds charged for it, and the provider's own record of it (`provider_record`: its start, end and proxy bytes), read once when the session is let go. With it a person running AgentRun sees how long each session ran, spots one that ended late or was lost, and finds each on the provider's own dashboard and invoice by its id. A provider that keeps no record, or a read that fails, says so in `provider_record_status`, with the record null, never zeros. In the computer package, a browser provider may offer `sessionUsage(ref)`, the vendor's record of a session; Browserbase's reads `GET /v1/sessions/{id}`.
