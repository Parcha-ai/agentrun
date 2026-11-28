---
packages: @parcha/agentrun-serve
kind: feature
---
On an API-only server with the launch hook set, a request in a workspace (`AgentRun-Workspace`, a server token) now makes a webhook trigger on its own workspace's agent (`POST /v2/triggers`) and rotates its secret (`POST /v2/triggers/{trigger_id}/secret`). Each shows the signing secret once, as `signing_secret`: a replay under the same `Idempotency-Key`, a read and a list show none, and nothing the server keeps holds it. After a rotation the old secret signs nothing. Another workspace's trigger answers the same `404` as a missing one. `rotateTriggerSecret`'s security in the API document now names the scoped server token (`bearer`) beside the owner's session. Outside a workspace the token is still refused a rotation and shown no secret.
