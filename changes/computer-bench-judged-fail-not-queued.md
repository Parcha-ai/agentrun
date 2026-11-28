---
packages: @parcha/agentrun-computer-bench
kind: fix
---
computer-bench no longer sends a grader's fail on a task whose checks are not sufficient to the human queue as "the grader says fail where the checks say pass". Passing checks on such a task only say nothing structural went wrong, so the grader's verdict decides the run either way; the queue keeps the runs the grader can't decide (`unknown`) or that no grader read.
