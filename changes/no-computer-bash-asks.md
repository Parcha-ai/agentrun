---
packages: @parcha/agentrun-serve
kind: fix
---
On a run with no computer, `bash` now asks for approval before it runs when no setting names it. This matches the kernel's rule (`defaultPermissionOf`): with no computer, bash asks first and the background tools are refused. Before, the runner's gate used the computer's default and allowed bash unasked. That mattered in Mode 2 (Archil), where a no-computer run still has bash on the folder's own exec, on pi and on the CLI harnesses. A tool setting still wins over the default, and a run on a computer allows them as before.

Serve's first-use Codex install is now fenced to the pinned tarballs: a test holds the install lock serve ships (`harnesses/codex/package-lock.json`) to the Codex adapter's `CODEX_NPM_INTEGRITY`, so a lock that drifts from the pin fails CI before `npm ci` would trust it.
