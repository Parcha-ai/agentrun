---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run that a person stops while a model node streams now books the stopped request at what streamed plus 1,024 tokens. Before, it could sometimes count the request at its whole hold instead. The run's end now waits, for at most two seconds, until every model request the run sent is booked, as an agentic run's end already does.
