---
packages: @parcha/agentrun-adapters
kind: feature
---
The model proxy's `origin` may now carry a path: a gateway that serves the API under one (`https://gateway.example/api`) gets each request at that path plus the route's (`/api/v1/...`). Before, the path was dropped and the request went to the origin's own `/v1/...`. A base with userinfo, a query, a fragment or a backslash is refused when the proxy starts, so the provider's key goes only where the base reads.
