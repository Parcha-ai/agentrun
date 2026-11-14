---
packages: @parcha/agentrun-serve
kind: fix
---
A wrong grade with no words no longer tells the model the verdict two to four times. The round's steer carries only the words, else "A right answer holds: {…}", else "(no words)"; the revise and look-back asks each say the verdict once. One constant (`LABEL_MAX`, 4000) now caps a grade's words in the API, the revise ask and its graded answer.
