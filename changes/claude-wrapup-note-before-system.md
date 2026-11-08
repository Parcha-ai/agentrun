---
packages: @parcha/agentrun-harness-claude
kind: fix
---
A capped Claude Code run told to wrap up at the start of a turn no longer fails that turn. The CLI ends a turn's first request with a system message of its own, and the provider takes one only before an assistant message or at the end, so the note sent as a user message after it was refused (400) and the turn failed. The note now goes as the last block of the last user message, and the CLI's system message stays last.
