---
packages: @parcha/agentrun-serve
kind: fix
---
An OpenCode run the server stopped in its first seconds (a restart, a deploy) now picks up where it was when the server comes back, and answers the person's message. Before, the turn was ended as if the person had stopped it, and the run waited for input with the message unanswered. A person's own Stop still stops the turn for good, and "Go on." is a turn of its own.
