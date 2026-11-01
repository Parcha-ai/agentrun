---
packages: repo
kind: feature
---
The console starts runs. The Operator is one composer: pick an agent, give it its first message, and the run starts and opens. The playground is `POST /v2/agents/{id}/runs` as a request form (input, revision, effort, spend cap) or its JSON. It shows the same request as cURL and JavaScript, and the server's answer with a way into the run. A retry of the same request reuses its `Idempotency-Key`, so the server answers with the run it already started.
