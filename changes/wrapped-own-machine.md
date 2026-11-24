---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/wrapped` answers only on one owner's own machine: a server that takes more than one API token, or keeps its store in Postgres, now refuses it with 403 like any other shared server, instead of handing the machine user's year to every token holder. The home is read on the import worker thread, priced at the server's own catalog (a model the server lists is no longer counted as unpriced). A read that takes longer than 15 seconds answers 503 with `retry_after_ms` while it carries on. A server reads one year at a time: asking for several years at once no longer starts a worker for each, holding each year's sessions in memory together, and a year waiting its turn answers 503 with a retry too. A year that was over before its read began stays kept until the server stops; any other year is read again once its minute has passed, so a read that began before New Year is read again, whole, after it. A year after the current one is 400.
