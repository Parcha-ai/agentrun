---
packages: @parcha/agentrun-serve
kind: fix
---
An imported agent now runs as imported. Before, a project with no CLAUDE.md or AGENTS.md was imported with empty instructions, and a Codex session's model was pinned as it was named (`openai/gpt-6.1-codex`, the Codex app's own model, which no key here reaches). Every run was refused with 409 `agent_not_runnable`. Now such a project's agent gets short instructions of the import's own ("You work on the project <name>. Your past runs are its Codex sessions, imported. …"), and a session's model is pinned only when a model catalog here lists it. Otherwise the agent runs on the server's default model for its harness, and each imported run still names the model it ran on. Agents imported before this change keep their revisions: set their model and instructions on the agent page, or import into a new data directory.
