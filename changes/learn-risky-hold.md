---
packages: @parcha/agentrun-serve
kind: fix
---
A learned rule that changes what an agent trusts or skips now always waits for its owner's OK, whichever model grades it. Before, the hold rested on the grader's reading alone, and models read the same rule differently: "refunds up to $250 need no manager" was held by one grading model and used at once under another. The end-of-run turn now marks such a note `risky: true`, and a note is held when either the run's turn or the grader says it is risky. The grader reads each note without that mark, so it still judges the note on its own (a planted instruction is still dropped). The mark is never kept: a held note says so by its status. The grader's rubric also names a limit or threshold under which someone may go ahead alone as risky, however it is phrased.
