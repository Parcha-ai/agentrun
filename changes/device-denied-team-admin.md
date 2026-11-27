---
packages: @parcha/agentrun
kind: fix
---
`agentrun login`'s device sign-in, when the server denies it (`access_denied`, from the authorization endpoint or the poll), now also says that a team workspace takes a key only from a team admin: ask one to deploy for you, or sign in again and choose another workspace. The words are the CLI's own; the server's `error_description` is still never printed.
