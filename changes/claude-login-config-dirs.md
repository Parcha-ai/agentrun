---
packages: @parcha/agentrun-serve
kind: fix
---
Claude Code's login on this machine now uses the folders the server's env gives it only when they belong to the server's own user, as it already did for the home. Those folders are `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and `ANTHROPIC_CONFIG_DIR` or else `XDG_CONFIG_HOME`'s `anthropic`. Each one must be a folder that user owns, or a folder still to be made inside one it owns. A link counts by the folder it leads to, and only when that user or root made the link. A server started under a sudo that keeps the env (root, with the person's `CLAUDE_CONFIG_DIR`) no longer signs Claude Code in as root inside the person's folder. Where a folder fails the check, the turn-on and the sign-in at this machine's login are refused (403) in words that name the variable and the folder, no run goes on the login, and a login saved before is turned off at the start with the reason logged. AgentRun's own login, which keeps its folders in the data folder, is not affected. The refusal words now name the server's user (`uid 501 (svc)`, say), the home's refusal included.

Behaviour change: a login on this machine's folders that one of these variables points at another user's folder, which ran before, is turned off at the next start. Start the server as the person whose Claude plan it is, with that person's variables.
