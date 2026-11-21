---
packages: @parcha/agentrun-serve
kind: breaking
---
The apply answer (`POST /v2/templates/{template}/apply`) no longer carries `trigger_ids`: read each trigger's `trigger_id` from `triggers`, which lists the same triggers in the same order with their names, kinds and on or off. The TypeScript and Python clients' `ApplyTemplateResponse` drop the field.
