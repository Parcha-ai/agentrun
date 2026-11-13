---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, repo
kind: feature
---
Add learning wrappers for existing Claude Agent SDK and Codex SDK backend agents. Applications keep their model configuration, tools, credentials, job triggers and cancellation; AgentRun records each task and supplies approved notes and skills to the next fresh SDK session. Server-side reflection has no tools and uses the existing structural checks, independent grading and owner-review controls before learning is reused. Cookbooks demonstrate an existing backend agent learning an instruction and using it on its next run.

SDK runs use scoped credentials and immutable, idempotent evidence and completion records. Missing evidence drops learning while preserving the application's result, and interrupted paid reflection is never replayed automatically. Learning Off works without a server model key; enabling learning requires a configured server reflection/grading model. Resumed conversations and multi-turn input streams are not supported by these wrappers yet. An optional MCP bridge lets accepted workflows invoke explicitly registered existing backend tool callbacks; it does not install tools automatically. Stop the original SDK through the application's cancellation signal; the console cannot stop its external tools.

Running agents now describe the learned skills and workflows they received alongside their starting notes, including runs that start with learned skills and no notes.
