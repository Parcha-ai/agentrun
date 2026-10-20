---
packages: @parcha/pi-durable-disk
kind: ci
---
The disk demo's runtime snapshot (`daytona-snapshot.ts build <commit> --demo`) holds the third-party closure of `@parcha/agentrun-harness` too, so a box installs the harness's child app offline; `check-demo` imports its entries (the root, `child-app` and `place`).
