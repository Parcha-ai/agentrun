---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
On macOS, a sign-out that arrives while a status check is deleting the Keychain item a sign-in left under the account `unknown` waits on that delete, and when it fails or is killed at its limit, tries once more itself. Before, the sign-out answered with the item, which holds a refresh token, still in the login keychain. The harness's `claudeLogout` now answers `{ signedOut, leftoverGone }` in place of a boolean: the CLI's own answer, and whether that item is gone. When it may remain, serve's sign-out is not confirmed, and its words say how to delete it in Keychain Access.
