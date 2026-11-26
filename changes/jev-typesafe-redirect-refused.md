---
packages: @parcha/agentrun-jev
kind: fix
---
Jev's requests to TypeSafe or OpenRouter no longer follow a redirect when the host passes no `fetch`. A redirect fails the request, so the key never goes to another address. A host that passes its own `fetch` keeps full control of redirects.
