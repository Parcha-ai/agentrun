---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
The `bwrap` box id is removed from the box enum: it was never in a release and always reported itself unavailable. A place of `{ "mode": "sandbox", "box": "bwrap" }` is now a 422 `not_an_option`, and `capabilities.places.boxes` no longer lists it. A client that named `bwrap` picks `docker`, `modal` or `daytona` instead.
