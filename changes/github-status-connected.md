---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/integrations/github` always answers 200: `{connected: false}` when no GitHub App is connected, else `{connected: true, app_id, slug, installations}`. Not connected was a 404, which a browser logs as a page error on every console page that asks. `DELETE` with nothing connected is still 404. The console's Settings → GitHub page reads `connected`.
