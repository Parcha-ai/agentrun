---
packages: @parcha/agentrun-pi
kind: fix
---
The `agentrun` tool's description no longer tells the model that a run always restarts with no checkpoint resume. It says what the extension does: a run the session left interrupted or failed resumes from its journal when its draft, input, SOP and tools are unchanged, and any other run starts new.
