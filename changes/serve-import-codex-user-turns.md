---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve import` imports sessions from current Codex versions. These write the person's turns only as user messages, with no `user_message` event, so the importer found no message of the person's and skipped every such session unless `--all` was passed. The person's turns now come from the session's `user_message` events when it has any, as older versions wrote both, and otherwise from its user messages. A block the CLI adds is left out: a whole tagged element such as `<environment_context>…</environment_context>`, an AGENTS.md heading over `<INSTRUCTIONS>…</INSTRUCTIONS>`, or a bare tag around an image. Either way each turn is counted once.
