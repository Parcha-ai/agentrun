---
packages: @parcha/agentrun-claude-agent
kind: fix
---
The Claude Agent adapter's internal process layer no longer re-exports `zodShapeFromJsonSchema`: its session tools are served by AgentRun's own MCP server with each JSON Schema as given, so nothing in the package builds a zod shape. The helper stays in `@parcha/agentrun-adapters/process` for SDKs whose tool APIs take zod. Not part of this package's public exports.
