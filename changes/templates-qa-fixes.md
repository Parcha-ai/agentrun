---
packages: @parcha/agentrun-serve
kind: fix
---
Template fixes from QA on Render:
- On a gateway server, a package with only a model tier applied with `422 definition.model is "provider/model-id"`: the tier's model was the gateway's own id. That model is now left out, so the agent runs on the server's default.
- On a gateway server, a package's preferred model is no longer picked, since the gateway never said it serves it. Apply says so in a `model` warning; `overrides.model` picks one the gateway serves.
- `GET /v2/templates` shows each package's `author` and its answer's schema (`output: {schema, json_schema}`).
- `kyb`'s answer fits its output limit: the report is a short narrative, never a copy of the structured fields.
- `inbound-lead`'s score is computed from the criteria it lists, by its rubric, so a missed must or a met disqualifier always caps it.
- `market-monitor` reads small slices of pages (at most a few per company), so a weekly run fits its budget.
