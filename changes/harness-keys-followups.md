---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: fix
---
A saved harness key with no binding to any recipe file now says so: `reenter.why` is `not_bound`, not `recipe_changed`. That covers a key saved before keys were bound (0.1.0-beta.55 and earlier) and one whose binding write was cut off. The Harness keys page says "Not tied to a recipe file" beside it. `GET /capabilities` with a bearer the server does not take still answers, with no kept ids, and now also writes an `auth_failed` line (`reason=wrong_token`) like every other route. A `DELETE` of a key the harness doesn't hold is refused with the keys it does hold ("acme's keys are ACME_API_KEY."), never "acme runs on …" for an id no recipe runs.
