---
packages: @parcha/agentrun-harness-claude
kind: breaking
---
`claudeLogout` answers `{ signedOut, leftoverGone }` (the exported type `ClaudeLogout`) where it answered a boolean. `signedOut` is the boolean it answered before: the CLI's own sign-out exited 0 within its limit. `leftoverGone` says whether the Keychain item a sign-in left under the account `unknown` at AgentRun's own folder on macOS is gone. Who breaks: a caller that reads the answer as a boolean, since an object is always truthy. What to do: read `signedOut` where you read the answer, and tell the person to delete the item in Keychain Access when `leftoverGone` is false.
