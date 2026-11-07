---
packages: repo
kind: ci
---
The held package `@parcha/agentrun-learn` (`packages/learn`) is removed. Nothing imported it, and it was never published to npm. The server's learning code lives in `@parcha/agentrun-serve` (`src/learn/`) and is unchanged. The release lists, `verify-packages`, the source export, the build and test orders and the documentation no longer name it, and the release preflight's held-package tests use `@parcha/agentrun-computer`, which is still held.
