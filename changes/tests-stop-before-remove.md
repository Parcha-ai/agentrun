---
packages: repo
kind: ci
---
Tests no longer remove a temporary directory while a server or child they started in it still writes there. node:test runs a test's after-hooks in the order they were added, so a removal added as the directory was made ran before the stop added after it (ENOTEMPTY on CI). The serve suite's `scratch()` and the npx command's tests now remove their directories once the file's tests are done, and the helpers that make and stop their own processes add the stop before the removal.
