---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's decision rows are now cleaned and cut like every other timeline row. Each URL in a row's summary or text keeps its origin, path and query keys and loses its query values, fragment and credentials. The summary is cut at 500 characters and the text at 2,000. A decision stored before receipts kept their status now reads as answered or failed from its rule and error instead of `undefined`, and an old route names the branch it took. When a run's decisions can't be read, its timeline's usage row reads unknown instead of showing the model nodes' cost alone. `GET /v2/openapi.json` now lists `decision` in `TimelineKind`, marked `decision-rows/1`, so a client that validates rows against it accepts them.
