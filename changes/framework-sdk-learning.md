---
packages: @parcha/agentrun-client, @parcha/agentrun-serve
kind: feature
---
Connect existing OpenAI Agents SDK and LangGraph JavaScript agents to AgentRun's checked workflow learning. The wrappers retain the application's execution and native memory, report bounded task evidence and usage, and inject owner corrections and pinned workflows into fresh tasks. A host can explicitly supply the existing local MCP workflow bridge over its own approved callbacks. These external runs cannot be launched, stopped or resumed by AgentRun. Unsupported or incomplete evidence preserves the native result but prevents learning and is reported by `flushLearning()`.
