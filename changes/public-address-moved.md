---
packages: @parcha/agentrun-serve
kind: feature
---
The server remembers its public address (`AGENTRUN_PUBLIC_URL`) in its data directory once a start serves, and warns when a start changes it. A start that fails remembers nothing. The warning is one log line, `event=public_url_changed from=<old> to=<new>`. It says that the owner signs in again at the new address and that links in earlier webhook messages point to the old one. Before, the change signed the owner out with no word.
When the old name still reaches the server, a browser that opens the console there is redirected (308, `no-store`) to the new address, keeping the link's `#/runs/<id>`. On a loopback listener the rest stays refused, as before. The API and webhooks get a 403 `forbidden` that now names the new address, and another browser page gets a page that links to it. The redirect and the page apply only when the server has a public address now. Every other name is refused as before, and its Host is never repeated.
