---
packages: @parcha/agentrun-computer
kind: fix
---
The Cloudflare relay no longer answers a create with a bare 500 when its container is slow to start: the idle timeout is set outside `blockConcurrencyWhile`, whose 30 s limit reset the object, every route answers a failure as `{ error }` in words, and the provider sends a create answered 500, 502 or 503 again (the relay answers a repeated name with the first's row). Redeploy the relay from this release.
