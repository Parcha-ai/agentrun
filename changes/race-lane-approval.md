---
packages: @parcha/agentrun-serve
kind: fix
---
A race lane whose call waited on the owner's approval showed only "Working · Steps appear as the agent takes them." with a spinner, and nothing to answer: the owner had to open the run to find the approval. The lane now offers the run page's approval card, compact, answered in place (Allow once, Deny, a note), and says "Waiting for your approval" without a spinner until the answer lands. An ACP agent's call that waits on approval (Cursor, Antigravity) also read as the gate's JSON around the agent's own input, its `toolCallId` and the agent's bookkeeping fields included, with a command's newlines as `\n`. Its approval row now reads as the command the agent named (a `CommandLine`, `command` or `cmd` in its input), newlines kept, or else the call's title. Other calls' rows are as before.
