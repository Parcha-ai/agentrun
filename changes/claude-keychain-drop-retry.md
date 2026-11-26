---
packages: @parcha/agentrun-harness-claude
kind: fix
---
On macOS, a delete of the Keychain item a sign-in left under the account `unknown` that is killed at its limit, or fails, is asked again at the next sign-in or status check, until the item is deleted or found gone. Before, the item was marked dealt with before the delete started, so it stayed for the life of the server. The sign-in's end also settles now should that delete throw before it starts.
