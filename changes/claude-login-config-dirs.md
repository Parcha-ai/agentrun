---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
Claude Code's login on this machine now uses the folders the server's env gives it only when they belong to the server's own user, as it already did for the home. Those folders are `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and `ANTHROPIC_CONFIG_DIR` or else `XDG_CONFIG_HOME`'s `anthropic`. Each one must be a folder that user owns, or a folder still to be made inside one it owns. The home and these folders are judged by one rule, so that no other user can change where the path leads after the check:

- The path is resolved first, so a trailing slash, `.` or `..` hides nothing. Each link on the way, and each link in the chain it leads through, must be one that user or root made.
- Each folder above the real folder must be that user's or root's, and not one its group or anyone else may write in, unless the sticky bit keeps each entry its maker's (as /tmp has it).
- The folder itself must be that user's and not open to its group's or anyone's writes. So must the folder a still-to-make one is made in, sticky or not, so a folder still to make in /tmp is refused, root's included.
- The CLI gets the real path the check looked at (the home included), not the path as given. Where the env's path has a link on it, the shown sign-in line and the CLI now name the folder the link leads to. On macOS the CLI names its Keychain item after that folder, so a login the person's own Claude Code keeps under a path with a link reads as signed out until it is signed in again from here.

A server started under a sudo that keeps the env (root, with the person's `CLAUDE_CONFIG_DIR`) no longer signs Claude Code in as root inside the person's folder. Where a folder fails the check, the turn-on and the sign-in at this machine's login are refused (403) in words that name the variable and the folder, no run goes on the login, and a login saved before is turned off at the start with the reason logged. AgentRun's own login, which keeps its folders in the data folder, is not affected. The refusal words now name the server's user (`uid 501 (svc)`, say), the home's refusal included.

Where the env's `HOME` is another user's and the login therefore uses the server's user's own home, the sign-in line the Settings view shows now carries `HOME=<that home>`. Before, it left `HOME` to the terminal, so the line run in the person's terminal signed in to their own home, which the server never reads. The harness's `ClaudeAgentLogin` has a new optional `homeApart` that asks for this.

Behaviour change: a login on this machine's folders that one of these variables points at another user's folder, or reaches through another user's link or folder, or through a folder its group may write in, which ran before, is turned off at the next start. Start the server as the person whose Claude plan it is, with that person's variables, and make the folders on the way writable by their owner alone.
