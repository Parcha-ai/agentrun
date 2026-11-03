---
packages: @parcha/agentrun-serve
kind: feature
---
An agentic run is told of the files given to it. Its first message, on every harness, is the input's `content`, then a blank line and one line naming each file in its `work/inputs/` by the path its tools take, with its size: `Files for this run: inputs/notes.txt (32 B), inputs/docs/plan.md (1.5 KB).`, at most 20 and then how many more, and never past what the run's door takes in one message. A run asked to "summarize the attached file" used to be given the file but never its name. The run's `input` is stored as it was sent; the timeline's first `user_message` is the message the harness got, the line included. A run given no files is sent its `content` as before.
