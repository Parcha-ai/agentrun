---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
On macOS, a native Claude Code runtime now finds the person's login when the server was started without `USER`, as a service launchd starts may be. The `claude` it starts for the sign-in check and for each turn names its Keychain item's account by `USER`, and without one it looked under `unknown`, read signed out and refused every turn. Where the server's environment has no `USER` or `LOGNAME`, or an empty one, they are now set to the user the server runs as; a `USER` it has is kept as it is.

At AgentRun's own login folder, the Keychain item an earlier console sign-in left under the account `unknown` is now deleted once the item under the Mac user is there: after a sign-in from the console, or at the first status check that reads signed in. Items of this machine's own Claude Code login, and items under any other account, are never touched.
