---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
On macOS, a sign-out that arrives while a status check is deleting the Keychain item a sign-in left under the account `unknown` waits on that delete, and when it fails or is killed at its limit, tries once more itself. Before, the sign-out answered with the item, which holds a refresh token, still in the login keychain. When the item may remain, serve's sign-out is not confirmed, and its words name the item's exact service, to search in Keychain Access or delete with one `security` command, so they never point at the person's own CLI's item. The harness exports that service as `claudeKeychainService`.
