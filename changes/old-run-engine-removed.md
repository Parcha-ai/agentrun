---
packages: @parcha/agentrun-serve
kind: fix
---
The server no longer ships the old run engine. Every run already went through the runner and the one store, but the per-run process (`app.ts`, `harness-app.ts`, `request-start.ts`, `run-box.ts`) and the file-era run kernel (`runs.ts`) were still in the package, and nothing called them. Their tests are gone with them. What the runner and the server still read from them moved to its live home first: a run's secrets (`run-secrets.ts`), the claim refusal's words (`run-view.ts`) and the box settings the server checks at its start (`box-settings.ts`). Nothing a person or a model sees changes.
