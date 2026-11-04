---
packages: @parcha/agentrun-serve
kind: fix
---
A run's files line quotes each name as a JSON string, with any control, format or line-separator character as its `\uXXXX` escape: `Files for this run: "inputs/notes.txt" (32 B).` A name holding `", ` could forge another entry, and an RTL override or a zero-width character could reorder what the model read. The line also reads only `work/`'s own `inputs/`, walked from `work/` as the run's file list is: a link at `inputs` names nothing from where it points, and the run starts as before.
