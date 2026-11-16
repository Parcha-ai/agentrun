---
packages: @parcha/agentrun-serve
kind: feature
---
The console applies a template whose setup is only parameters (no MCP tool, no key) from its own screen: Apply is the main action there and Configure on its card, and "Set it up with an agent" is the second way. A template with more to set up keeps Run as its main action. On such a template that reads mail (an `email_*` tool or an email trigger), Apply waits for a mailbox saved under Settings → Email and links there, instead of being refused.
