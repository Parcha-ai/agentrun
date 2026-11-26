---
packages: @parcha/agentrun-serve
kind: fix
---
An API-only server (`AGENTRUN_API_ONLY=1`) now serves an ended run's share bundle (`GET /runs/{id}/export`, with its `?restore=`) to its token: before, it answered `404` and `agentrun share` failed against it. The bundle is the full server's, cut by the same scrubber, and a run that has not ended is still `409`. The share preview page stays the console's, which this profile refuses: use `agentrun share RUN --out FILE` there.
