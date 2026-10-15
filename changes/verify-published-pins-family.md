---
packages: repo
kind: ci
---

The release's last step, `verify-published`, installs its consumer with the same `@earendil-works` pins the package check uses, and fails if the install lands on a version the repository lockfile does not hold. Before, the consumer floated pi-codemode to a release that dropped an export pi-coding-agent imports, and the step failed after every package had published.

The floor legs of `scripts/pi-leg.mjs` pin the packages the family depends on outside it (pi-codemode and pi-mcp under the coding agent) at the leg's version too, and fail a leg whose coding agent loads one at another version. Before, they stayed green only because the lockfile held pi-codemode 1.1.0; a refresh to 1.2.0, which dropped an export that coding agents 1.0.4 and 1.1.x import, would have broken them.
