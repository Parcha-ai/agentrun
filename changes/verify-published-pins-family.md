---
packages: repo
kind: ci
---

The release's last step, `verify-published`, installs its consumer with the same `@earendil-works` pins the package check uses, and fails if the install lands on a version the repository lockfile does not hold. Before, the consumer floated pi-codemode to a release that dropped an export pi-coding-agent imports, and the step failed after every package had published.
