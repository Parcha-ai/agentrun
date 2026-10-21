---
packages: @parcha/agentrun-pi
kind: feature
---
`recordCommits`, `snapshotLines` and `recordingLines` (`@parcha/agentrun-pi/durable`) write a durable `pi.conversation` line for each conversation record (recording draft 54): `data` is `{ id, parent?, owner? }` as pi records them (`parent { conversationId, at }` for a fork, `owner { conversationId, taskId }` for the creator), integer ids and nothing else, placed before its entries in its commit and in the snapshot at open. A bare store read dates a conversation at the first commit that wrote an entry or a document of it, or at the last commit when it has neither. A consumer that counted every line without a `doc` as a task must now skip `kind === "pi.conversation"`.
