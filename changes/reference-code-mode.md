---
packages: repo
kind: feature
---
The reference entry has an opt-in code mode (`DemoOptions.codeMode`, or `codeMode` in demo.json): a `code` tool whose script runs in pi-codemode's sandbox with `tools.bash` (through the call's environment, in `work/`) and the vision handle's `vision.see`. Off by default; the sandbox has no network, process or file access of its own, and a command it runs can do what the environment's shell can.
The repository now declares `@earendil-works/pi-codemode` as a root devDependency, the one extra install code mode needs.
