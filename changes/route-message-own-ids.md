---
packages: @parcha/agentrun-serve
kind: fix
---
Each answer the Messages route serves to Claude Code gets an id of its own. The id was the clock's milliseconds, so two answers started in the same millisecond shared one: a stream that stalled and the whole answer Claude Code asked for again, or two requests side by side. A claude-agent run then took the whole answer for the stalled stream's and showed only the part that had streamed, never the rest.
