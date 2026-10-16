---
packages: repo
kind: ci
---
The stranger job's `registry` mode, which installs `@parcha/pi-durable-disk@beta` from the registry with the README's own
install line as written and runs the README's quickstart, is blocking: 0.1.0-beta.14, whose peer ranges accept pi below
1.4, installs with it, where 0.1.0-beta.13 (ranges below 1.3) failed with ERESOLVE once pi 1.3.0 shipped.
