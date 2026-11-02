---
packages: @parcha/agentrun-kernel
kind: feature
---
`delegateTool`: a lead hands one task to a named sub-agent, `delegate({ agent, task, context? })`, as an ordinary host tool for a lead on any harness. Each call runs a durable child `agent` node with the agent's own system prompt, only its own subset of the lead's tools, and a fixed answer shape (`DELEGATE_RESULT_SCHEMA`: `answer`, `citations`, `gaps`).
The child keeps its session under `<lead's key>/delegate:<call id>`, so the call is replay-safe: a finished child answers from its record, and one a crash cut off resumes from its own store without sending its paid requests again. Its requests go through the lead's `beforeRequest`, and its deadline is the lead's or the agent's share of the time left. Children run one at a time, never delegate further, and their events carry a `delegate` tag. `delegateProblems` checks a definition before the tool is made.
- A host tool's call context carries the runner's `sessionDir`, when it has one, so a tool that runs a node of its own (the delegate) gives its child a private directory the same way, by the child's key.
