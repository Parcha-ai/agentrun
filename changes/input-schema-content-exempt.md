---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's `input_schema` `maxProperties` and `propertyNames` now count and name the input's own fields only, never `content`. `content` is always accepted, since it carries a run's message, a trigger's line and event, and a schedule's last answer. Before, a schema capped at one field refused `{ "company": "Acme", "content": "" }`, so a trigger for that agent could not be saved with its typed field and a message, and its runs could not get their event or last answer. A schema's own fields still meet both keywords, and a refusal names the schema's own number.
