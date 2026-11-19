---
packages: @parcha/agentrun-serve
kind: fix
---
A run's views no longer show a `Bearer` token or the value of a URL parameter named like a credential (`?api_key=`, `&access_token=`, `&client_secret=`, a signed URL's `sig=` or `X-Amz-Signature=`) when the server holds neither value. Both are new secret shapes, cut to `[redacted]` wherever a run's text is served: its Timeline, its trace (`GET /v2/runs/{id}/trace`) and the Dev tools tab, its answer and its error. The scheme and the parameter's name stay, so `Authorization: Bearer [redacted]` and `?api_key=[redacted]` still say what was sent. Learning refuses a draft that holds either, as it does every other secret shape.
A token is twenty characters or more with a digit among them, and a parameter's value sixteen or more, so a placeholder (`Bearer <token>`, `Bearer $TOKEN`), a challenge (`Bearer realm="x"`) and a parameter that only resembles a credential's name (`page_token`, `sort_key`) are left as written.
