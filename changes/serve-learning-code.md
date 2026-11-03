---
packages: @parcha/agentrun-serve
kind: feature
---
The server's learning code is its own, in `src/learn/`, beside `SPEC.md`, the learning folder's contract: the note format (`notes.ts`), the checker of what a run proposes (`check.ts`), the end-of-run prompt (`reflect.ts`) and the grader's rubric, prompt and verdict (`grade.ts`). The server depends on no learning package: `@parcha/agentrun-learn` stays held and unchanged, and an install of the server gets nothing more than before.
- A note may name the notes it replaces, `supersedes: [old.md]` or one bare file name. Only the server sets `status: superseded` and `superseded_by`, on each note a merged one supersedes, and a run that sets either is refused.
- `SPEC.md` lists the checker's rules and caps, the grader's four questions (general, from content, duplicate, contradicts) and how its verdict fails closed.
