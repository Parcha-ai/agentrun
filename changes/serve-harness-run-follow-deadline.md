---
packages: repo
kind: ci
---
**serve's harness-run tests wait for a run as long as they allow themselves**
- Each of the file's 60 s tests followed its run with `follow()`'s default 30 s deadline, so under load a run that needed more than 30 s failed "the run did not reach completed" with half the test's budget unused. They now pass `deadlineMs: 60_000`, as the file's other tests do.
