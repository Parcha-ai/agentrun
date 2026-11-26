---
packages: @parcha/agentrun-harness-claude
kind: fix
---
On macOS, when `security` hangs on the delete of the Keychain item a sign-in left under the account `unknown`, signed-in status checks no longer wait on it each time: checks at once share one delete, and after a delete is killed or fails, status checks leave the item for ten minutes (a sign-in still asks at once). The CLI's own sign-out at AgentRun's own folder now removes that leftover item too.
