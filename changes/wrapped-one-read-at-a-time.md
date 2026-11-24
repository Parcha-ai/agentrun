---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/wrapped` reads one year at a time on a server: asking for several years at once no longer starts a worker for each, holding each year's sessions in memory together. A year waiting its turn answers 503 with a retry, like any long read. This year's read that began before New Year is no longer kept until the server stops: once kept past a minute, the year is read again, now whole.
