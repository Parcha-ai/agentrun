---
packages: @parcha/pi-durable-agent
kind: fix
---
The session vault no longer keeps a provider context for more origins than its capture allows. A context's own `origins` that go beyond the capture's are refused (`AgentHomeError` `invalid`, naming the fault and no origin or context id) and nothing is written, since an opaque context cannot be cut down and would keep those origins' sign-ins. A restore gives a provider context back only to a request that names every origin it was captured for and every origin it records; any other gets `null`.
