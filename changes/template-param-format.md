---
packages: @parcha/agentrun-serve
kind: feature
---
A template's string parameter can say what its value is with `format`: `cron` (a schedule's cron line) or `timezone` (an IANA time zone), shown on `GET /v2/templates`, so a form can ask for it with a schedule picker and a time-zone choice instead of raw text. `market-monitor` marks its `cron` and `timezone` parameters so.
