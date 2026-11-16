---
type: llm
---
The prompt is a pasted diff with no pull request behind it. AgentRun saves the run's message as `inputs/message.md`, so
the diff travels once: each reviewer is told where it is, never handed a copy.

Look at every `subagent` call in the tool calls, and at its `prompt` argument. Pass only when all of these hold:

- there is at least one `subagent` call;
- every `subagent` call's prompt names `inputs/message.md`;
- no `subagent` call's prompt carries any of the diff: no line of it, whole or in part (for example
  `STACK_LIMIT_QUOKKA`, `applyCoupons`, `percentOff`, a `@@` hunk header or a `--- a/` / `+++ b/` file header);
- no call of any other tool (`write`, `bash`, codemode or any other) carries the diff either.

Answer pass or fail, and quote each `subagent` call's prompt, cut to its first 300 characters.
