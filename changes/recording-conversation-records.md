---
packages: repo
kind: feature
---
**A recording keeps each conversation's record, and the validator checks it (draft 54)**
- `apps/viewer/RECORDING.md` adds the `pi.conversation` line, one per conversation record pi writes: `{ id, parent?, owner? }`, with `parent { conversationId, at }` (the conversation it was forked from and the entry it inherits through) and `owner { conversationId, taskId }` (the task that created it), and no content. A panel places a forked conversation under its parent at `parent.at` and ties it to the call that made it through `owner.taskId`. In a conversation with an owner, a `pi.user` entry is its creator's message, never "You", unless a person's submission names it. A copied `reference.label` is never read as a link.
- `scripts/recording/validate.mjs` refuses a `pi.conversation` that holds anything beyond `id`, `parent` and `owner`, or whose `parent.conversationId`, `parent.at` (an entry of that conversation) or `owner.taskId` (a task record) is not in the recording.
