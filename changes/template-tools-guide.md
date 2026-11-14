---
packages: @parcha/agentrun-serve
kind: docs
---
A one-page guide for template authors on giving a template tools (`templates/TOOLS.md`): how to declare built-in tools, a Composio toolkit and monid, how to pin a tool's arguments to the owner's parameters, what asks the owner and what runs unasked, and which toolkits are proven live.
The serve README's "Finding and calling the run's tools" now says that a deny of `tools_search` or `tools_call` turns Claude Code's ToolSearch off and lists every tool, that Settings → Tools lists the three, and that a `codemode` script leaves a harness's prefix off a tool's name.
