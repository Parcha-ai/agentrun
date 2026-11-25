---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
On macOS, signing Claude Code in from the console now saves the login's Keychain item under the Mac user the server runs as, so `claude auth status` in that person's terminal reads it signed in, as AgentRun's badge does. Before, the claude CLI that AgentRun starts for the sign-in, the status check and a run got no `USER`. The CLI names the Keychain item's account by `USER`, and without it the account was `unknown`. The badge, asked the same way, read signed in, while the person's own `claude`, which has `USER`, looked under their name and read signed out. Those three now carry `USER` and `LOGNAME` set to the user the server runs as, as the system names it (`os.userInfo()`), even when the server itself was started without `USER`, as a service launchd starts may be, or with another user's.

Behaviour change: a login signed in from the console on macOS before this fix reads signed out once the server is updated, since its item is under `unknown`. Sign in again under Settings → Model keys. The old item stays in the Keychain under `unknown` and is no longer read; Keychain Access can delete it.
