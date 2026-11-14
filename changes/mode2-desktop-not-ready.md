---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2, an E2B or Agent37 desktop is no longer shown as ready. Like their sandboxes, it would mount the run's folder and needs Archil's image in your own vendor account, which this server can't put there yet. An E2B desktop failed at its start after a computer was made. Settings → Computers now says so, an agent's save warns in the same words, and a run's start refuses it (409 `agent_not_runnable`) before any computer is made. Orgo's desktop, a phone and a browser mount nothing and run as before.
