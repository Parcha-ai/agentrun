---
packages: @parcha/agentrun-serve
kind: fix
---
A server stopped while setup is still counting this machine's sessions now exits at once. Before, its close waited for the count's worker to finish listing every session file, because the listing never checks for a stop. On a home with many sessions that held the exit for seconds, past the drain window. The count writes nothing, so close now ends its worker and waits for it to exit, and the next start counts again. An import under way still stops between two session files and is waited for, so nothing writes the store after close.
