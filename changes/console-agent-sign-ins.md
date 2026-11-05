---
packages: repo
kind: feature
---
An agent's page lists its saved browser sign-ins, from `GET /v2/agents/{id}`'s `sign_ins`. Each row shows its vendor (Browserbase, Kernel), when it was last verified (or that it isn't yet), and, while a run holds it, that run. An unreadable one says runs start signed out until it's forgotten. Forget asks first, then calls `DELETE /v2/agents/{id}/sign-ins/{key}` and reads the agent again. If the vendor doesn't confirm the delete, the row says so with the vendor's message. A sign-in a run is using can't be forgotten until that run ends, and the page says so with a link to the run. Nothing of a sign-in beyond those fields is shown. The section is hidden on a server that serves no `sign_ins`, and, when none is saved, it shows only for an agent whose browser is a vendor's.
