---
packages: @parcha/agentrun-harness-claude
kind: feature
---
`ClaudeAgentNotInstalled` says, in one line, what is missing and how to install it: the message keeps its prefix ("Claude Agent SDK not installed"), names the SDK, its platform package with the CLI, or the MCP library it brings as a peer, and ends with `; install it with: npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286`, which is also on the error as `install` (and exported as `CLAUDE_AGENT_SDK_INSTALL`). A `cliPath` that holds nothing keeps its own message, with no install line. A host that matched the whole message exactly now matches its prefix.
