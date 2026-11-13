---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, repo
kind: feature
---
Learn and reuse workflows in existing Claude Agent SDK and Codex SDK backends through an optional local MCP bridge. The backend explicitly registers its existing callbacks, schemas, permissions and prices. Ordinary skill promotion, structural checks, dry runs, independent grading and owner review decide which workflows are supplied to a fresh task. Workflow bodies and capabilities are pinned to that task; credentials and execution remain in the backend.

The bridge checks every tool invocation against live backend policy, enforces task-wide call limits and cancellation, and revokes access when the native task ends. It supplies no implicit shell, code executor, model or decision adapter and does not retry uncertain effects. New cookbooks and opt-in real-SDK examples verify workflow promotion, fresh-input reuse through the original callbacks, and a learning-Off control.
