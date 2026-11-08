---
packages: @parcha/agentrun-serve
kind: fix
---
The trigger sources, the schedule and the signed webhook, are adapters in one registry, and every list of sources is read from it: the source kinds a create takes and its check, a firing's `by` and key, the payload's tag, each run's provenance line, `GET /v2/capabilities` and the OpenAPI document's source schemas. Nothing a client sees changes, but the OpenAPI document's firing `by` now says what `manual` is. Upgrading: nothing to do.
