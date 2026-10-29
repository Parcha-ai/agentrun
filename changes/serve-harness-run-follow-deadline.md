---
packages: repo
kind: ci
---
**serve's harness-run tests wait for a run as long as they allow themselves, and still report where it stopped**
- Seven of the file's 60 s tests followed their run with `follow()`'s default 30 s deadline. Under load, a run that needed more than 30 s failed "the run did not reach completed" with half the test's budget unused.
- Every `follow()` in the file now waits 55 s, under its test's budget, so a run that never finishes fails with follow's own "last <state>" line rather than the test's timeout.
- The three tests that follow a run twice get 120 s.
