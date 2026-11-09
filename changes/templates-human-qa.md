---
packages: @parcha/agentrun-serve
kind: fix
---
Template fixes from the human QA on the QA cut:
- A template parameter can declare `enum`, a closed set of values that `GET /v2/templates` shows and apply checks (`not_an_option` outside it). `inbound-lead`'s `post_to` and `kyb`'s `risk_appetite` use it in place of a pattern, so the console shows a choice. Patterned parameters' descriptions now say their format in words ("a Slack channel ID like C0123ABCD").
- `kyb` raises a registry status flag (a dissolution notice, overdue filings) only from the company's own status and filing fields, never from help text a registry shows on every record, and checks the record again before such a flag moves the verdict. Corporations Canada is named among the registries, with that caveat, and a new eval case (an active Canadian corporation that has filed) holds it.
