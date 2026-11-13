---
packages: @parcha/agentrun-client
kind: feature
---
Backend workflow MCP bridges require an explicit host-owned `engine` with workflow inspection, execution and schema resolution. Import and supply the interpreter in the backend; the client no longer imports or declares a runtime peer dependency on the DSL. Guarded tool callbacks, live policy, budgets, cancellation and native run capabilities remain enforced by the bridge.
