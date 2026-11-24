---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/wrapped` answers only on one owner's own machine: a server that takes more than one API token, or keeps its store in Postgres, now refuses it with 403 like any other shared server, instead of handing the machine user's year to every token holder. The home is read on the import worker thread, priced at the server's own catalog (a model the server lists is no longer counted as unpriced). A read that takes longer than 15 seconds answers 503 with `retry_after_ms` while it carries on. A year that is over stays kept until the server stops, and a year after the current one is 400.
